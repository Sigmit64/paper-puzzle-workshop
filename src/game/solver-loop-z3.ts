import { cellsTouchedByAnchor, clueAnchorOf } from "./puzzle-model";
import type { PuzzleSolutionLayers } from "./puzzle-model";
import type { CellId, ClueInstance } from "./types";
import type { CompiledPuzzle } from "./solver-model";
import { LOOP_SUPPORTED_RULES, loopUnsupportedRules } from "./loop-pilot-validator";

/**
 * The encoder's supported vocabulary is the complete registered loop rule
 * set. A model with any other active rule is rejected before any SMT
 * assertion is made; silently dropping a rule would make parity meaningless.
 */
export const LOOP_Z3_RULES = LOOP_SUPPORTED_RULES;
/** Backward-compatible name for the pilot scripts; it now denotes the full
 * registered loop vocabulary accepted by this encoder. */
export const LOOP_Z3_PILOT_RULES = LOOP_Z3_RULES;

export class LoopZ3UnsupportedError extends Error {
  readonly code = "unsupported";

  constructor(message: string) {
    super(message);
    this.name = "LoopZ3UnsupportedError";
  }
}

/** The Node and browser wrappers expose the same Context API.  Keeping the
 * encoder independent from either wrapper lets the lazy browser Worker inject
 * its already-initialized API without pulling Z3 into the main bundle. */
export type LoopZ3Api = { Context: any };
type Z3Api = LoopZ3Api;
type Expr = any;

export interface LoopZ3Session {
  readonly api: Z3Api;
  readonly ctx: any;
  readonly model: CompiledPuzzle;
  readonly solver: any;
  readonly edgeVars: Map<string, Expr>;
  /** Rank is a finite in-SMT cyclic order for every selected cell.  It is
   * intentionally part of the proof model (rather than a JS projection):
   * all path-distance and segment rules below are expressed from it. */
  readonly rankVars: Map<CellId, Expr>;
  readonly activeCells: CellId[];
  readonly baseAssertionCount: number;
}

export type LoopZ3Classification = "unique" | "multiple" | "unsat" | "unknown" | "timeout";

export interface LoopZ3SolveResult {
  classification: LoopZ3Classification;
  timedOut: boolean;
  unknownReason?: string;
  checks: number;
  elapsedMs: number;
  signatures: string[];
  solutions: PuzzleSolutionLayers[];
}

function edgeKey(left: CellId, right: CellId) {
  return left < right ? `${left}-${right}` : `${right}-${left}`;
}

function parseCell(cell: CellId): [number, number] {
  const [row, column] = cell.split(":").map(Number);
  return [row, column];
}

function cellAt(row: number, column: number): CellId {
  return `${row}:${column}` as CellId;
}

function requireCellAnchor(clue: ClueInstance, active?: Set<CellId>): CellId {
  const anchor = clueAnchorOf(clue);
  if (!anchor || anchor.kind !== "cell") {
    throw new LoopZ3UnsupportedError(`pilot requires a cell anchor for ${clue.kind}`);
  }
  if (active && !active.has(anchor.cell)) throw new LoopZ3UnsupportedError(`clue crosses a removed or inactive cell: ${clue.id}`);
  return anchor.cell;
}

function requireEdgeAnchor(clue: ClueInstance, active: Set<CellId>): [CellId, CellId] {
  const anchor = clueAnchorOf(clue);
  if (!anchor || anchor.kind !== "edge") {
    throw new LoopZ3UnsupportedError(`pilot requires an internal edge anchor for ${clue.kind}`);
  }
  const cells = cellsTouchedByAnchor(anchor);
  if (cells.length !== 2 || cells.some((cell) => !active.has(cell))) {
    throw new LoopZ3UnsupportedError(`edge clue crosses a removed or inactive cell: ${clue.id}`);
  }
  const [first, second] = cells as [CellId, CellId];
  return [first, second];
}

function boolSum(ctx: any, expressions: Expr[]): Expr {
  if (expressions.length === 0) return ctx.Int.val(0);
  return ctx.Sum(...expressions.map((expression) => ctx.If(expression, 1, 0)));
}

function intSum(ctx: any, expressions: Expr[]): Expr {
  if (expressions.length === 0) return ctx.Int.val(0);
  return ctx.Sum(...expressions);
}

export function assertLoopZ3Supported(model: CompiledPuzzle): void {
  if (model.mechanic !== "loop") {
    throw new LoopZ3UnsupportedError(`loop encoder only accepts loop models, got ${model.mechanic}`);
  }
  const unsupported = loopUnsupportedRules(model);
  if (unsupported.length) {
    throw new LoopZ3UnsupportedError(`unsupported active loop rules: ${unsupported.join(", ")}`);
  }
  if (!model.globalRuleKeys.includes("loop.single-cycle")) {
    throw new LoopZ3UnsupportedError("loop.single-cycle is required by the encoder");
  }
}

/** Compatibility export for the Phase-0 pilot scripts. */
export const assertLoopZ3PilotSupported = assertLoopZ3Supported;

/** Build the complete SMT model once. Solving is performed by solveLoopZ3(). */
export function createLoopZ3Session(api: Z3Api, model: CompiledPuzzle): LoopZ3Session {
  assertLoopZ3Supported(model);
  const { Context } = api;
  const ctx = new Context("paper-puzzle-loop-pilot");
  const And: any = ctx.And.bind(ctx);
  const Or: any = ctx.Or.bind(ctx);
  const Implies: any = ctx.Implies.bind(ctx);
  const Not: any = ctx.Not.bind(ctx);
  const PbEq: any = ctx.PbEq.bind(ctx);
  const PbLe: any = ctx.PbLe.bind(ctx);
  const Solver: any = ctx.Solver;
  const Int: any = ctx.Int;
  const Bool: any = ctx.Bool;
  const activeCells = [...model.board.activeCells];
  const active = new Set(activeCells);
  const solver = new Solver();
  const edgeVars = new Map<string, Expr>();
  const rankVars = new Map<CellId, Expr>();
  const neighborEdges = new Map<CellId, Array<{ neighbor: CellId; edge: Expr }>>();
  const directions: Array<[number, number]> = [[-1, 0], [0, 1], [1, 0], [0, -1]];

  for (const cell of activeCells) neighborEdges.set(cell, []);
  if (activeCells.length === 0) {
    solver.add(ctx.Bool.val(false));
    return { api, ctx, model, solver, edgeVars, rankVars, activeCells, baseAssertionCount: solver.assertions().length() };
  }
  for (const cell of activeCells) {
    const [row, column] = parseCell(cell);
    for (const [rowStep, columnStep] of directions) {
      const neighbor = cellAt(row + rowStep, column + columnStep);
      if (!active.has(neighbor)) continue;
      const key = edgeKey(cell, neighbor);
      let edge = edgeVars.get(key);
      if (!edge) {
        edge = Bool.const(`edge_${key.replaceAll(":", "_").replace("-", "_to_")}`);
        edgeVars.set(key, edge);
      }
      neighborEdges.get(cell)!.push({ neighbor, edge });
    }
  }

  const visited = new Map(activeCells.map((cell) => [cell, Bool.const(`visited_${cell.replace(":", "_")}`)]));
  const degree = (cell: CellId) => neighborEdges.get(cell)!.map(({ edge }) => edge);
  for (const cell of activeCells) {
    if (degree(cell).length === 0) {
      solver.add(ctx.Bool.val(false));
      continue;
    }
    solver.add(PbLe(degree(cell), degree(cell).map(() => 1), 2));
    solver.add(Or(boolSum(ctx, degree(cell)).eq(0), boolSum(ctx, degree(cell)).eq(2)));
    solver.add(visited.get(cell)!.eq(boolSum(ctx, degree(cell)).eq(2)));
  }

  const edgeFor = (cell: CellId, rowStep: number, columnStep: number): Expr | undefined => {
    const [row, column] = parseCell(cell);
    const neighbor = cellAt(row + rowStep, column + columnStep);
    return neighborEdges.get(cell)!.find((item) => item.neighbor === neighbor)?.edge;
  };
  const orientation = (cell: CellId, kind: "straight" | "turn"): Expr => {
    const north = edgeFor(cell, -1, 0) ?? false;
    const east = edgeFor(cell, 0, 1) ?? false;
    const south = edgeFor(cell, 1, 0) ?? false;
    const west = edgeFor(cell, 0, -1) ?? false;
    const straight = Or(And(north, south), And(east, west));
    return kind === "straight" ? straight : Not(straight);
  };
  const turn = (cell: CellId) => orientation(cell, "turn");
  const straight = (cell: CellId) => orientation(cell, "straight");

  // A rank permutation turns the undirected degree-two graph into an exact
  // cyclic order.  Every selected edge must join consecutive ranks, while
  // every rank below |V| is occupied.  Together these assertions exclude
  // subtours without any model extraction or JS rejection.
  const totalVisited = boolSum(ctx, [...visited.values()]);
  const rankRules = new Set([
    "loop.cell-number.arm-length-sum", "loop.cell-number.outward-segment-length-sum",
    "loop.cell-dot.equal-arm-lengths", "loop.cell-dot.unequal-arm-lengths", "loop.cell-dot.arm-length-difference-one",
    "loop.cell-dot.masyu-white", "loop.cell-dot.masyu-black", "loop.cell-dot.pearl-black", "loop.cell-dot.pearl-white",
    "loop.edge-number.segment-length", "loop.edge-dot.segment-midpoint", "loop.edge-dot.split-cell-count-difference-one", "loop.edge-dot.split-cell-count-ratio-two",
  ]);
  const needsRank = [...model.globalRuleKeys, ...model.clueRules.map((rule) => rule.key)].some((key) => rankRules.has(key));
  if (needsRank) {
    for (const cell of activeCells) {
      const rank = Int.const(`rank_${cell.replace(":", "_")}`);
      rankVars.set(cell, rank);
      solver.add(Implies(visited.get(cell)!, rank.ge(0)), Implies(Not(visited.get(cell)!), rank.eq(-1)), rank.lt(activeCells.length));
    }
    for (let first = 0; first < activeCells.length; first += 1) {
      const occupants = activeCells.map((cell) => rankVars.get(cell)!.eq(first));
      const occupied = occupants.length ? occupants.reduce((left, right) => Or(left, right)) : ctx.Bool.val(false);
      solver.add(Implies(totalVisited.gt(first), occupied), Implies(totalVisited.le(first), Not(occupied)));
    }
    for (let first = 0; first < activeCells.length; first += 1) {
      for (let second = first + 1; second < activeCells.length; second += 1) {
        const left = activeCells[first];
        const right = activeCells[second];
        solver.add(Implies(And(visited.get(left)!, visited.get(right)!), Not(rankVars.get(left)!.eq(rankVars.get(right)!))));
      }
    }
  }
  const nextRank = (left: Expr, right: Expr): Expr => Or(
    right.eq(left.add(1)),
    And(left.eq(totalVisited.sub(1)), right.eq(0)),
  );
  for (const [key, edge] of edgeVars) if (needsRank) {
    const [left, right] = key.split("-") as [CellId, CellId];
    solver.add(Implies(edge, Or(nextRank(rankVars.get(left)!, rankVars.get(right)!), nextRank(rankVars.get(right)!, rankVars.get(left)!))));
  }

  const rankAtOffset = (origin: CellId, candidate: CellId, distance: number, direction: 1 | -1): Expr => {
    const originRank = rankVars.get(origin)!;
    const candidateRank = rankVars.get(candidate)!;
    const raw = direction === 1 ? originRank.add(distance) : originRank.sub(distance);
    const wrapped = direction === 1
      ? raw.sub(totalVisited)
      : raw.add(totalVisited);
    return And(visited.get(origin)!, visited.get(candidate)!, Or(candidateRank.eq(raw), candidateRank.eq(wrapped)));
  };
  const turnAtOffset = (origin: CellId, distance: number, direction: 1 | -1) =>
    Or(...activeCells.map((candidate) => And(rankAtOffset(origin, candidate, distance, direction), turn(candidate))));
  const distanceToTurn = (origin: CellId, direction: 1 | -1) => {
    let expression: Expr = ctx.Int.val(activeCells.length + 1);
    for (let distance = activeCells.length; distance >= 1; distance -= 1) {
      expression = ctx.If(turnAtOffset(origin, distance, direction), distance, expression);
    }
    return expression;
  };
  const sideRun = (left: CellId, right: CellId): Expr => {
    const forward = nextRank(rankVars.get(left)!, rankVars.get(right)!);
    return (ctx.If as any)(turn(left), 0, (ctx.If as any)(forward as any, distanceToTurn(left, -1), distanceToTurn(left, 1)));
  };
  const edgeRunCounts = (left: CellId, right: CellId): [Expr, Expr] => [
    sideRun(left, right).add(1), sideRun(right, left).add(1),
  ];
  const clueKeysByKind = new Map<string, Set<string>>();
  for (const rule of model.clueRules) {
    const keys = clueKeysByKind.get(rule.clueKind) ?? new Set<string>();
    keys.add(rule.key);
    clueKeysByKind.set(rule.clueKind, keys);
  }
  const hasClueRule = (clue: ClueInstance, key: string) => clueKeysByKind.get(clue.kind)?.has(key) ?? false;
  const nonCountableCells = new Set(model.board.clues.flatMap((clue) => {
    const anchor = clueAnchorOf(clue);
    if (anchor?.kind !== "cell") return [];
    const blocking = [
      "loop.cell-number.orthogonal-unvisited", "loop.cell-number.eight-visited", "loop.cell-number.eight-turns",
      "loop.cell-number.eight-unvisited", "loop.cell-number.four-visited", "loop.cell-number.four-turns",
      "loop.cell-number.outward-segment-length-sum", "loop.cell-dot.unvisited",
      "loop.cell-dot.unvisited-component-center-symmetric", "loop.cell-dot.unvisited-component-axis-symmetric",
    ].some((key) => hasClueRule(clue, key));
    return blocking ? [anchor.cell] : [];
  }));

  const cellNeighbors = (cell: CellId, diagonal = false) => {
    const [row, column] = parseCell(cell);
    const result: CellId[] = [];
    for (const rowStep of (diagonal ? [-1, 0, 1] : [-1, 0, 1])) {
      for (const columnStep of (diagonal ? [-1, 0, 1] : [-1, 0, 1])) {
        if (rowStep === 0 && columnStep === 0) continue;
        if (!diagonal && rowStep !== 0 && columnStep !== 0) continue;
        const candidate = cellAt(row + rowStep, column + columnStep);
        if (active.has(candidate)) result.push(candidate);
      }
    }
    return result;
  };
  const edgeAt = (left: CellId, right: CellId): Expr => edgeVars.get(edgeKey(left, right)) ?? ctx.Bool.val(false);
  const lineRun = (start: CellId, rowStep: number, columnStep: number): Expr => {
    let row: number;
    let column: number;
    [row, column] = parseCell(start);
    let prefix: Expr = ctx.Bool.val(true);
    const terms: Expr[] = [];
    for (let length = 1; length <= activeCells.length; length += 1) {
      const next = cellAt(row + rowStep, column + columnStep);
      prefix = And(prefix, edgeAt(cellAt(row, column), next));
      terms.push(ctx.If(prefix, 1, 0));
      if (!active.has(next)) break;
      row += rowStep;
      column += columnStep;
    }
    return intSum(ctx, terms);
  };
  const cellInside = (row: number, column: number): Expr => {
    if (row < 0 || row > model.board.rows || column < 0 || column > model.board.columns) return ctx.Bool.val(false);
    const crossings: Expr[] = [];
    for (let currentColumn = column; currentColumn < model.board.columns; currentColumn += 1) {
      const upper = cellAt(row - 1, currentColumn);
      const lower = cellAt(row, currentColumn);
      if (active.has(upper) && active.has(lower)) crossings.push(edgeAt(upper, lower));
    }
    if (crossings.length === 0) return ctx.Bool.val(false);
    if (crossings.length === 1) return crossings[0]!;
    return (ctx.Xor as any)(...crossings);
  };
  const cellsTouchedVertex = (row: number, column: number) => [
    cellAt(row - 1, column - 1), cellAt(row - 1, column),
    cellAt(row, column - 1), cellAt(row, column),
  ].filter((cell) => active.has(cell));
  const lineSegments = (anchor: Extract<NonNullable<ReturnType<typeof clueAnchorOf>>, { kind: "exterior" }>) => {
    const horizontal = anchor.side === "left" || anchor.side === "right";
    const starts: Array<{ start: CellId; edge: Expr; previous: Expr; length: Expr }> = [];
    const fixed = anchor.index;
    const count = horizontal ? model.board.columns - 1 : model.board.rows - 1;
    for (let offset = 0; offset < count; offset += 1) {
      const start = horizontal ? cellAt(fixed, offset) : cellAt(offset, fixed);
      const next = horizontal ? cellAt(fixed, offset + 1) : cellAt(offset + 1, fixed);
      const previous = offset === 0
        ? ctx.Bool.val(false)
        : horizontal ? edgeAt(cellAt(fixed, offset - 1), start) : edgeAt(cellAt(offset - 1, fixed), start);
      const edge = edgeAt(start, next);
      starts.push({ start, edge, previous, length: lineRun(start, horizontal ? 0 : 1, horizontal ? 1 : 0) });
    }
    return starts;
  };
  const lineSegmentCount = (anchor: Extract<NonNullable<ReturnType<typeof clueAnchorOf>>, { kind: "exterior" }>) => {
    const starts = lineSegments(anchor);
    return boolSum(ctx, starts.map(({ edge, previous }) => And(edge, Not(previous))));
  };
  const constrainLineMeasure = (anchor: Extract<NonNullable<ReturnType<typeof clueAnchorOf>>, { kind: "exterior" }>, target: number, measure: "count" | "longest" | "shortest") => {
    const starts = lineSegments(anchor).map(({ edge, previous, length }) => ({ start: And(edge, Not(previous)), length }));
    if (measure === "count") {
      solver.add(lineSegmentCount(anchor).eq(target));
      return;
    }
    const activeStarts = starts.map(({ start, length }) => And(start, length.eq(target)));
    solver.add(Or(...activeStarts));
    for (const { start, length } of starts) {
      solver.add(Implies(start, measure === "longest" ? length.le(target) : length.ge(target)));
    }
  };
  const unvisitedComponent = (start: CellId): Map<CellId, Expr> => {
    let reachable = new Map(activeCells.map((cell) => [cell, cell === start ? Not(visited.get(cell)!) : ctx.Bool.val(false)] as const));
    // A simple-path bound of |V|-1 is exact for a finite unvisited component.
    for (let step = 0; step < activeCells.length - 1; step += 1) {
      const next = new Map<CellId, Expr>();
      for (const cell of activeCells) {
        const adjacent = cellNeighbors(cell).map((neighbor) => reachable.get(neighbor)!);
        next.set(cell, And(Not(visited.get(cell)!), Or(reachable.get(cell)!, ...(adjacent.length ? adjacent : [ctx.Bool.val(false)]))));
      }
      reachable = next;
    }
    return reachable;
  };
  const componentSymmetry = (start: CellId, transforms: Array<(row: number, column: number) => CellId>) => {
    const membership = unvisitedComponent(start);
    return transforms.map((transform) => {
      const equalities: Expr[] = [];
      for (const cell of activeCells) {
        const [row, column] = parseCell(cell);
        const counterpart = transform(row, column);
        equalities.push(membership.get(cell)!.eq(active.has(counterpart) ? membership.get(counterpart)! : false));
      }
      return And(...equalities);
    });
  };

  // Topology-independent local/global rules.
  if (model.globalRuleKeys.includes("loop.unvisited-not-adjacent")) {
    for (const cell of activeCells) for (const neighbor of cellNeighbors(cell)) {
      if (cell < neighbor && !nonCountableCells.has(cell) && !nonCountableCells.has(neighbor)) solver.add(Or(visited.get(cell)!, visited.get(neighbor)!));
    }
  }

  // The four vertex parity crossings are the same ray-casting convention as
  // solver-loop.ts, but expressed entirely as Boolean XOR in the SMT model.
  for (const clue of model.board.clues) {
    const value = clue.value;
    const anchor = clueAnchorOf(clue);
    if (!anchor) continue;
    if (anchor.kind === "cell") {
      const cell = requireCellAnchor(clue, active);
      const orthogonal = cellNeighbors(cell);
      const surrounding = cellNeighbors(cell, true);
      const ordinaryUnvisited = (neighbor: CellId) => And(Not(visited.get(neighbor)!), Not(nonCountableCells.has(neighbor)));
      if (value !== undefined && hasClueRule(clue, "loop.cell-number.orthogonal-unvisited")) solver.add(And(Not(visited.get(cell)!), boolSum(ctx, orthogonal.map(ordinaryUnvisited)).eq(value)));
      if (value !== undefined && hasClueRule(clue, "loop.cell-number.eight-visited")) solver.add(And(Not(visited.get(cell)!), boolSum(ctx, surrounding.map((neighbor) => visited.get(neighbor)!)).eq(value)));
      // Unlike orthogonal-unvisited, this carrier counts every non-loop cell,
      // including state2 clue cells; this is the legacy binaryClues meaning.
      if (value !== undefined && hasClueRule(clue, "loop.cell-number.eight-unvisited")) solver.add(And(Not(visited.get(cell)!), boolSum(ctx, surrounding.map((neighbor) => Not(visited.get(neighbor)!))).eq(value)));
      if (value !== undefined && hasClueRule(clue, "loop.cell-number.four-visited")) solver.add(And(Not(visited.get(cell)!), boolSum(ctx, orthogonal.map((neighbor) => visited.get(neighbor)!)).eq(value)));
      if (value !== undefined && hasClueRule(clue, "loop.cell-number.eight-turns")) solver.add(And(Not(visited.get(cell)!), boolSum(ctx, surrounding.map((neighbor) => And(visited.get(neighbor)!, turn(neighbor)))).eq(value)));
      if (value !== undefined && hasClueRule(clue, "loop.cell-number.four-turns")) solver.add(And(Not(visited.get(cell)!), boolSum(ctx, orthogonal.map((neighbor) => And(visited.get(neighbor)!, turn(neighbor)))).eq(value)));
      if (value !== undefined && hasClueRule(clue, "loop.cell-number.inside-vertex-count")) {
        const [row, column] = parseCell(cell);
        solver.add(boolSum(ctx, [cellInside(row, column), cellInside(row + 1, column), cellInside(row, column + 1), cellInside(row + 1, column + 1)]).eq(value));
      }
      if (value !== undefined && hasClueRule(clue, "loop.cell-number.arm-length-sum")) solver.add(And(visited.get(cell)!, distanceToTurn(cell, 1).add(distanceToTurn(cell, -1)).eq(value)));
      if (value !== undefined && hasClueRule(clue, "loop.cell-number.outward-segment-length-sum")) solver.add(And(Not(visited.get(cell)!), intSum(ctx, orthogonal.map((neighbor) => { const [r, c] = parseCell(neighbor); const [cr, cc] = parseCell(cell); return lineRun(neighbor, r - cr, c - cc); })).eq(value)));
      if (hasClueRule(clue, "loop.cell-dot.equal-arm-lengths")) solver.add(And(visited.get(cell)!, distanceToTurn(cell, 1).eq(distanceToTurn(cell, -1))));
      if (hasClueRule(clue, "loop.cell-dot.unequal-arm-lengths")) solver.add(And(visited.get(cell)!, Not(distanceToTurn(cell, 1).eq(distanceToTurn(cell, -1)))));
      if (hasClueRule(clue, "loop.cell-dot.arm-length-difference-one")) solver.add(And(visited.get(cell)!, Or(distanceToTurn(cell, 1).sub(distanceToTurn(cell, -1)).eq(1), distanceToTurn(cell, -1).sub(distanceToTurn(cell, 1)).eq(1))));
      if (hasClueRule(clue, "loop.cell-dot.visited")) solver.add(visited.get(cell)!);
      if (hasClueRule(clue, "loop.cell-dot.unvisited")) solver.add(Not(visited.get(cell)!));
      const straightRule = hasClueRule(clue, "loop.cell-dot.straight") || hasClueRule(clue, "loop.white-dot.straight");
      const turnRule = hasClueRule(clue, "loop.cell-dot.turn") || hasClueRule(clue, "loop.black-dot.turn");
      if (straightRule) solver.add(And(visited.get(cell)!, straight(cell)));
      if (turnRule) solver.add(And(visited.get(cell)!, turn(cell)));
      const previousTurn = needsRank ? turnAtOffset(cell, 1, -1) : ctx.Bool.val(false);
      const nextTurn = needsRank ? turnAtOffset(cell, 1, 1) : ctx.Bool.val(false);
      if (hasClueRule(clue, "loop.cell-dot.masyu-white")) solver.add(And(visited.get(cell)!, straight(cell), Or(previousTurn, nextTurn)));
      if (hasClueRule(clue, "loop.cell-dot.masyu-black")) solver.add(And(visited.get(cell)!, turn(cell), Not(previousTurn), Not(nextTurn)));
      if (hasClueRule(clue, "loop.cell-dot.pearl-black")) solver.add(And(visited.get(cell)!, previousTurn, nextTurn));
      if (hasClueRule(clue, "loop.cell-dot.pearl-white")) solver.add(And(visited.get(cell)!, Not(previousTurn), Not(nextTurn)));
      if (hasClueRule(clue, "loop.cell-dot.unvisited-component-center-symmetric")) {
        const [row, column] = parseCell(cell);
        solver.add(Not(visited.get(cell)!));
        solver.add(Or(...componentSymmetry(cell, [(r, c) => cellAt(2 * row - r, 2 * column - c)])));
      }
      if (hasClueRule(clue, "loop.cell-dot.unvisited-component-axis-symmetric")) {
        const [row, column] = parseCell(cell);
        solver.add(Not(visited.get(cell)!));
        solver.add(Or(...componentSymmetry(cell, [
          (r, c) => cellAt(r, 2 * column - c),
          (r, c) => cellAt(2 * row - r, c),
          (r, c) => cellAt(row + c - column, column + r - row),
          (r, c) => cellAt(row - c + column, column - r + row),
        ])));
      }
    }
    if (anchor.kind === "edge") {
      const cells = cellsTouchedByAnchor(anchor);
      if (cells.length !== 2 || cells.some((cell) => !active.has(cell))) throw new LoopZ3UnsupportedError(`edge clue crosses a removed or inactive cell: ${clue.id}`);
      const [left, right] = cells as [CellId, CellId];
      const edge = edgeAt(left, right);
      const [leftRun, rightRun] = needsRank ? edgeRunCounts(left, right) : [ctx.Int.val(0), ctx.Int.val(0)];
      if (value !== undefined && hasClueRule(clue, "loop.edge-number.segment-length")) solver.add(And(edge, leftRun.add(rightRun).sub(1).eq(value)));
      if (value !== undefined && hasClueRule(clue, "loop.edge-number.outward-segment-length-sum")) {
        const directions = anchor.orientation === "vertical" ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]];
        solver.add(And(Not(edge), lineRun(left, directions[0]![0]!, directions[0]![1]!).add(lineRun(right, directions[1]![0]!, directions[1]![1]!)).eq(value)));
      }
      if (value !== undefined && hasClueRule(clue, "loop.edge-number.visited-cell-count")) solver.add(boolSum(ctx, [visited.get(left)!, visited.get(right)!]).eq(value));
      if (hasClueRule(clue, "loop.edge-dot.segment-midpoint")) solver.add(And(edge, leftRun.eq(rightRun)));
      if (hasClueRule(clue, "loop.edge-dot.split-cell-count-difference-one")) solver.add(And(edge, Or(leftRun.sub(rightRun).eq(1), rightRun.sub(leftRun).eq(1))));
      if (hasClueRule(clue, "loop.edge-dot.split-cell-count-ratio-two")) solver.add(And(edge, Or(leftRun.eq(rightRun.mul(2)), rightRun.eq(leftRun.mul(2)))));
      if (hasClueRule(clue, "loop.edge-dot.same-cell-orientation")) solver.add(And(visited.get(left)!, visited.get(right)!, turn(left).eq(turn(right))));
      if (hasClueRule(clue, "loop.edge-dot.opposite-cell-orientation")) solver.add(And(visited.get(left)!, visited.get(right)!, Not(turn(left).eq(turn(right)))));
      if (hasClueRule(clue, "loop.edge-dot.exactly-one-cell-visited")) solver.add(boolSum(ctx, [visited.get(left)!, visited.get(right)!]).eq(1));
    }
    if (anchor.kind === "vertex") {
      const cells = cellsTouchedVertex(anchor.row, anchor.column);
      if (value !== undefined && hasClueRule(clue, "loop.vertex-number.visited-cell-count")) solver.add(boolSum(ctx, cells.map((cell) => visited.get(cell)!)).eq(value));
      if (value !== undefined && hasClueRule(clue, "loop.vertex-number.turn-count")) solver.add(boolSum(ctx, cells.map((cell) => And(visited.get(cell)!, turn(cell)))).eq(value));
      if (value !== undefined && hasClueRule(clue, "loop.vertex-number.used-edge-count")) {
        const [a, b, c, d] = [cellAt(anchor.row - 1, anchor.column - 1), cellAt(anchor.row - 1, anchor.column), cellAt(anchor.row, anchor.column - 1), cellAt(anchor.row, anchor.column)];
        solver.add(boolSum(ctx, [edgeAt(a, b), edgeAt(c, d), edgeAt(a, c), edgeAt(b, d)]).eq(value));
      }
      if (hasClueRule(clue, "loop.vertex-dot.inside")) solver.add(cellInside(anchor.row, anchor.column));
      if (hasClueRule(clue, "loop.vertex-dot.outside")) solver.add(Not(cellInside(anchor.row, anchor.column)));
      if (hasClueRule(clue, "loop.vertex-dot.more-visited")) solver.add(boolSum(ctx, cells.map((cell) => visited.get(cell)!)).ge(3));
      if (hasClueRule(clue, "loop.vertex-dot.more-unvisited")) solver.add(boolSum(ctx, cells.map((cell) => visited.get(cell)!)).le(1));
    }
    if (anchor.kind === "exterior") {
      if (value !== undefined && hasClueRule(clue, "loop.exterior-number.visited-cell-count")) {
        const observed = anchor.side === "left" || anchor.side === "right"
          ? activeCells.filter((cell) => parseCell(cell)[0] === anchor.index)
          : activeCells.filter((cell) => parseCell(cell)[1] === anchor.index);
        solver.add(boolSum(ctx, observed.map((cell) => visited.get(cell)!)).eq(value));
      }
      if (value !== undefined && hasClueRule(clue, "loop.exterior-number.parallel-segment-count")) constrainLineMeasure(anchor, value, "count");
      if (value !== undefined && hasClueRule(clue, "loop.exterior-number.longest-parallel-segment")) constrainLineMeasure(anchor, value, "longest");
      if (value !== undefined && hasClueRule(clue, "loop.exterior-number.shortest-parallel-segment")) constrainLineMeasure(anchor, value, "shortest");
    }
  }

  for (const clue of model.board.clues) {
    if (hasClueRule(clue, "loop.cell-dot.visited")) solver.add(visited.get(requireCellAnchor(clue, active)) ?? false);
    if (hasClueRule(clue, "loop.cell-dot.unvisited")) solver.add(Not(visited.get(requireCellAnchor(clue, active)) ?? true));
    const straightKeys = ["loop.cell-dot.straight", "loop.white-dot.straight"];
    const turnKeys = ["loop.cell-dot.turn", "loop.black-dot.turn"];
    const cell = requireCellAnchorIfNeeded(clue, active, straightKeys.some((key) => hasClueRule(clue, key)) || turnKeys.some((key) => hasClueRule(clue, key)));
    if (cell) {
      if (straightKeys.some((key) => hasClueRule(clue, key))) solver.add(And(visited.get(cell)!, straight(cell)));
      if (turnKeys.some((key) => hasClueRule(clue, key))) solver.add(And(visited.get(cell)!, turn(cell)));
    }
    if (hasClueRule(clue, "loop.edge-dot.traversed") || hasClueRule(clue, "loop.edge-dot.not-traversed")) {
      const [first, second] = requireEdgeAnchor(clue, active);
      const edge = edgeVars.get(edgeKey(first, second));
      if (!edge) throw new LoopZ3UnsupportedError(`edge clue has no legal topology edge: ${clue.id}`);
      if (hasClueRule(clue, "loop.edge-dot.traversed")) solver.add(edge);
      if (hasClueRule(clue, "loop.edge-dot.not-traversed")) solver.add(Not(edge));
    }
  }

  if (model.globalRuleKeys.includes("loop.visit-all-unclued-cells")) {
    const cellClues = new Set(model.board.clues.flatMap((clue) => {
      const anchor = clueAnchorOf(clue);
      return anchor?.kind === "cell" ? [anchor.cell] : [];
    }));
    for (const cell of activeCells) if (!cellClues.has(cell)) solver.add(visited.get(cell)!);
  }

  // A single dynamic root plus integer flow gives an in-SMT global
  // connectivity proof. Every non-root visited cell consumes one unit; the
  // unique root supplies all other visited cells. Disconnected subtours have
  // no possible supply and are therefore UNSAT before model projection.
  const roots = new Map(activeCells.map((cell) => [cell, Bool.const(`root_${cell.replace(":", "_")}`)]));
  solver.add(PbEq([...roots.values()], [...roots.values()].map(() => 1), 1));
  const directedFlows = new Map<string, Expr>();
  for (const [key, edge] of edgeVars) {
    const parts = key.split("-");
    const left = parts[0] as CellId;
    const right = parts[1] as CellId;
    for (const [from, to] of [[left, right], [right, left]] as const) {
      const flow = Int.const(`flow_${from.replace(":", "_")}_to_${to.replace(":", "_")}`);
      directedFlows.set(`${from}>${to}`, flow);
      solver.add(flow.ge(0), flow.le(activeCells.length), Implies(Not(edge), flow.eq(0)));
    }
  }
  const flowsAt = (cell: CellId, incoming: boolean) => {
    const expressions: Expr[] = [];
    for (const { neighbor } of neighborEdges.get(cell)!) {
      const key = incoming ? `${neighbor}>${cell}` : `${cell}>${neighbor}`;
      expressions.push(directedFlows.get(key)!);
    }
    return intSum(ctx, expressions);
  };
  for (const cell of activeCells) {
    const incoming = flowsAt(cell, true);
    const outgoing = flowsAt(cell, false);
    const root = roots.get(cell)!;
    const nonRootVisited = And(visited.get(cell)!, Not(root));
    solver.add(Implies(root, visited.get(cell)!));
    solver.add(Implies(root, outgoing.sub(incoming).eq(totalVisited.sub(1))));
    solver.add(Implies(nonRootVisited, incoming.sub(outgoing).eq(1)));
    solver.add(Implies(Not(visited.get(cell)!), incoming.eq(outgoing)));
  }

  return { api, ctx, model, solver, edgeVars, rankVars, activeCells, baseAssertionCount: solver.assertions().length() };
}

function requireCellAnchorIfNeeded(clue: ClueInstance, active: Set<CellId>, needed: boolean): CellId | undefined {
  if (!needed) return undefined;
  return requireCellAnchor(clue, active);
}

export async function solveLoopZ3(session: LoopZ3Session, budgetMs = session.model.timeBudgetMs): Promise<LoopZ3SolveResult> {
  const started = performance.now();
  const deadline = started + budgetMs;
  const signatures: string[] = [];
  const solutions: PuzzleSolutionLayers[] = [];
  let checks = 0;
  let timedOut = false;
  let unknownReason: string | undefined;
  const timeout = () => Math.max(1, Math.ceil(deadline - performance.now()));
  const setTimeout = () => session.solver.set("timeout", timeout());

  session.solver.push();
  try {
    setTimeout();
    const first = await session.solver.check();
    checks += 1;
    if (first === "unknown") {
      unknownReason = session.solver.reasonUnknown() as string;
      timedOut = /timeout/i.test(unknownReason);
      return { classification: timedOut ? "timeout" : "unknown", timedOut, unknownReason, checks, elapsedMs: performance.now() - started, signatures, solutions };
    }
    if (first === "unsat") return { classification: "unsat", timedOut: false, checks, elapsedMs: performance.now() - started, signatures, solutions };

    const z3Model = session.solver.model();
    const selected = [...session.edgeVars.entries()].filter(([, edge]) => modelBooleanFromSession(session, z3Model, edge));
    const signature = selected.map(([key]) => key).sort().join("|");
    if (session.model.solutionLimit > 0) signatures.push(signature);
    if (session.model.solutionLimit > 0) solutions.push({ loop: signature.split("|").filter(Boolean).map((part) => {
      const separator = part.indexOf("-");
      return { from: part.slice(0, separator) as CellId, to: part.slice(separator + 1) as CellId };
    }) });
    // solutionLimit controls retained projections only.  It must never skip
    // the complete edge blocking check, otherwise a multiple board could be
    // misreported as unique when callers request one retained solution.
    session.solver.add(session.ctx.Or(...[...session.edgeVars.entries()].map(([key, edge]) => edge.eq(!selected.some(([selectedKey]) => selectedKey === key)))));
    setTimeout();
    const second = await session.solver.check();
    checks += 1;
    if (second === "unknown") {
      unknownReason = session.solver.reasonUnknown() as string;
      timedOut = /timeout/i.test(unknownReason);
      return { classification: timedOut ? "timeout" : "unknown", timedOut, unknownReason, checks, elapsedMs: performance.now() - started, signatures, solutions };
    }
    if (second === "unsat") return { classification: "unique", timedOut: false, checks, elapsedMs: performance.now() - started, signatures, solutions };
    const secondModel = session.solver.model();
    const secondSelected = [...session.edgeVars.entries()].filter(([, edge]) => modelBooleanFromSession(session, secondModel, edge));
    const secondSignature = secondSelected.map(([key]) => key).sort().join("|");
    if (secondSignature === signature) throw new Error("Z3 returned an identical model after a complete edge blocking clause");
    if (signatures.length < session.model.solutionLimit) signatures.push(secondSignature);
    if (solutions.length < session.model.solutionLimit) solutions.push({ loop: secondSignature.split("|").filter(Boolean).map((part) => {
      const separator = part.indexOf("-");
      return { from: part.slice(0, separator) as CellId, to: part.slice(separator + 1) as CellId };
    }) });
    return { classification: "multiple", timedOut: false, checks, elapsedMs: performance.now() - started, signatures, solutions };
  } finally {
    session.solver.pop();
  }
}

function modelBooleanFromSession(session: LoopZ3Session, model: any, expression: Expr): boolean {
  // Context.isTrue is stable across z3-solver 5.x and avoids string parsing.
  return session.ctx.isTrue(model.eval(expression, true));
}

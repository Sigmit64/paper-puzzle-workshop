import { init } from "z3-solver/build/node.js";
import { cellsTouchedByAnchor, clueAnchorOf } from "./puzzle-model";
import type { PuzzleSolutionLayers } from "./puzzle-model";
import type { CellId, ClueInstance } from "./types";
import type { CompiledPuzzle } from "./solver-model";
import { LOOP_PILOT_RULES, loopPilotUnsupportedRules } from "./loop-pilot-validator";

/**
 * The pilot is deliberately a small, auditable slice of the loop rules.  A
 * model with any other active rule is rejected before any SMT assertion is
 * made; silently dropping a rule would make benchmark numbers meaningless.
 */
export const LOOP_Z3_PILOT_RULES = LOOP_PILOT_RULES;

export class LoopZ3UnsupportedError extends Error {
  readonly code = "unsupported";

  constructor(message: string) {
    super(message);
    this.name = "LoopZ3UnsupportedError";
  }
}

type Z3Api = Awaited<ReturnType<typeof init>>;
type Expr = any;

export interface LoopZ3Session {
  readonly api: Z3Api;
  readonly ctx: any;
  readonly model: CompiledPuzzle;
  readonly solver: any;
  readonly edgeVars: Map<string, Expr>;
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

export function assertLoopZ3PilotSupported(model: CompiledPuzzle): void {
  if (model.mechanic !== "loop") {
    throw new LoopZ3UnsupportedError(`pilot only accepts loop models, got ${model.mechanic}`);
  }
  const unsupported = loopPilotUnsupportedRules(model);
  if (unsupported.length) {
    throw new LoopZ3UnsupportedError(`unsupported active loop rules: ${unsupported.join(", ")}`);
  }
  if (!model.globalRuleKeys.includes("loop.single-cycle")) {
    throw new LoopZ3UnsupportedError("loop.single-cycle is required by the pilot encoder");
  }
}

/** Build the complete SMT model once. Solving is performed by solveLoopZ3(). */
export function createLoopZ3Session(api: Z3Api, model: CompiledPuzzle): LoopZ3Session {
  assertLoopZ3PilotSupported(model);
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
  const neighborEdges = new Map<CellId, Array<{ neighbor: CellId; edge: Expr }>>();
  const directions: Array<[number, number]> = [[-1, 0], [0, 1], [1, 0], [0, -1]];

  for (const cell of activeCells) neighborEdges.set(cell, []);
  if (activeCells.length === 0) {
    solver.add(ctx.Bool.val(false));
    return { api, ctx, model, solver, edgeVars, activeCells, baseAssertionCount: solver.assertions().length() };
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

  const clueKeysByKind = new Map<string, Set<string>>();
  for (const rule of model.clueRules) {
    const keys = clueKeysByKind.get(rule.clueKind) ?? new Set<string>();
    keys.add(rule.key);
    clueKeysByKind.set(rule.clueKind, keys);
  }
  const hasClueRule = (clue: ClueInstance, key: string) => clueKeysByKind.get(clue.kind)?.has(key) ?? false;

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
  const totalVisited = boolSum(ctx, [...visited.values()]);
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

  return { api, ctx, model, solver, edgeVars, activeCells, baseAssertionCount: solver.assertions().length() };
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
    signatures.push(signature);
    solutions.push({ loop: signature.split("|").filter(Boolean).map((part) => {
      const separator = part.indexOf("-");
      return { from: part.slice(0, separator) as CellId, to: part.slice(separator + 1) as CellId };
    }) });
    if (session.model.solutionLimit <= 1) return { classification: "unique", timedOut: false, checks, elapsedMs: performance.now() - started, signatures, solutions };
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
    signatures.push(secondSignature);
    solutions.push({ loop: secondSignature.split("|").filter(Boolean).map((part) => {
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

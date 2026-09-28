import { cellsObservedByExterior, cellsTouchedByAnchor, clueAnchorOf } from "./puzzle-model";
import type { LoopSegment } from "./puzzle-model";
import type { CellId, ClueInstance } from "./types";
import type { CompiledPuzzle } from "./solver-model";

export interface LoopPilotValidation {
  valid: boolean;
  errors: string[];
  signature: string;
}

/** Rules understood by both the SMT pilot and the legacy acceptance gate. */
export const LOOP_PILOT_RULES = [
  "loop.single-cycle",
  "loop.visit-all-unclued-cells",
  "loop.cell-dot.visited",
  "loop.cell-dot.unvisited",
  "loop.cell-dot.straight",
  "loop.cell-dot.turn",
  "loop.white-dot.straight",
  "loop.black-dot.turn",
  "loop.edge-dot.traversed",
  "loop.edge-dot.not-traversed",
] as const;

/** Complete loop registry.  This is data-only so the encoder and the
 * independent validator can reject unknown rules consistently without a Z3
 * dependency.  The validator below remains the small pilot acceptance gate;
 * full-rule acceptance is added alongside the full encoder. */
export const LOOP_SUPPORTED_RULES = [
  "loop.single-cycle", "loop.unvisited-not-adjacent", "loop.visit-all-unclued-cells",
  "loop.cell-number.orthogonal-unvisited", "loop.cell-number.eight-visited", "loop.cell-number.eight-turns", "loop.cell-number.eight-unvisited", "loop.cell-number.four-visited", "loop.cell-number.four-turns", "loop.cell-number.inside-vertex-count", "loop.cell-number.outward-segment-length-sum", "loop.cell-number.arm-length-sum",
  "loop.edge-number.segment-length", "loop.edge-number.outward-segment-length-sum", "loop.edge-number.visited-cell-count",
  "loop.vertex-number.visited-cell-count", "loop.vertex-number.used-edge-count", "loop.vertex-number.turn-count",
  "loop.cell-dot.visited", "loop.cell-dot.unvisited", "loop.cell-dot.unvisited-component-center-symmetric", "loop.cell-dot.unvisited-component-axis-symmetric", "loop.cell-dot.equal-arm-lengths", "loop.cell-dot.unequal-arm-lengths", "loop.cell-dot.arm-length-difference-one", "loop.cell-dot.straight", "loop.cell-dot.turn", "loop.cell-dot.masyu-white", "loop.cell-dot.masyu-black", "loop.cell-dot.pearl-black", "loop.cell-dot.pearl-white",
  "loop.edge-dot.traversed", "loop.edge-dot.not-traversed", "loop.edge-dot.segment-midpoint", "loop.edge-dot.split-cell-count-difference-one", "loop.edge-dot.split-cell-count-ratio-two", "loop.edge-dot.same-cell-orientation", "loop.edge-dot.opposite-cell-orientation", "loop.edge-dot.exactly-one-cell-visited",
  "loop.vertex-dot.outside", "loop.vertex-dot.inside", "loop.vertex-dot.more-visited", "loop.vertex-dot.more-unvisited",
  "loop.exterior-number.visited-cell-count", "loop.exterior-number.parallel-segment-count", "loop.exterior-number.longest-parallel-segment", "loop.exterior-number.shortest-parallel-segment",
  "loop.white-dot.straight", "loop.black-dot.turn",
] as const;
const LOOP_SUPPORTED_RULE_SET = new Set<string>(LOOP_SUPPORTED_RULES);

export function loopUnsupportedRules(model: CompiledPuzzle): string[] {
  const keys = new Set([...model.globalRuleKeys, ...model.clueRules.map((rule) => rule.key)]);
  return [...keys].filter((key) => !LOOP_SUPPORTED_RULE_SET.has(key));
}

const LOOP_PILOT_RULE_SET = new Set<string>(LOOP_PILOT_RULES);

export function loopPilotUnsupportedRules(model: CompiledPuzzle): string[] {
  const keys = new Set([...model.globalRuleKeys, ...model.clueRules.map((rule) => rule.key)]);
  return [...keys].filter((key) => !LOOP_PILOT_RULE_SET.has(key));
}

export function isLoopPilotCompatibleModel(model: CompiledPuzzle): boolean {
  return model.mechanic === "loop"
    && model.globalRuleKeys.includes("loop.single-cycle")
    && loopPilotUnsupportedRules(model).length === 0;
}

function edgeKey(left: CellId, right: CellId) {
  return left < right ? `${left}-${right}` : `${right}-${left}`;
}

function parseCell(cell: CellId): [number, number] {
  const [row, column] = cell.split(":").map(Number);
  return [row, column];
}

export function loopIsStraight(cell: CellId, before: CellId, after: CellId): boolean {
  const [row, column] = parseCell(cell);
  const [beforeRow, beforeColumn] = parseCell(before);
  const [afterRow, afterColumn] = parseCell(after);
  return (beforeRow === row && afterRow === row) || (beforeColumn === column && afterColumn === column);
}

export function loopOrientationMatches(cell: CellId, before: CellId, after: CellId, requirement: "straight" | "turn") {
  const straight = loopIsStraight(cell, before, after);
  return requirement === "straight" ? straight : !straight;
}

function areOrthogonal(left: CellId, right: CellId) {
  const [leftRow, leftColumn] = parseCell(left);
  const [rightRow, rightColumn] = parseCell(right);
  return Math.abs(leftRow - rightRow) + Math.abs(leftColumn - rightColumn) === 1;
}

function cellAt(row: number, column: number): CellId {
  return `${row}:${column}` as CellId;
}

function hasRule(model: CompiledPuzzle, clueKind: string, key: string) {
  return model.clueRules.some((rule) => rule.clueKind === clueKind && rule.key === key);
}

type ModelClue = CompiledPuzzle["board"]["clues"][number];

function anchorCell(clue: ModelClue, active: Set<CellId>): CellId | undefined {
  const anchor = clueAnchorOf(clue);
  if (anchor?.kind !== "cell") return undefined;
  if (!active.has(anchor.cell)) return undefined;
  return anchor.cell;
}

/**
 * Independent, non-SMT validator for the exact pilot subset. It is used by
 * both legacy and Z3 benchmark results. In particular, it does not call Z3
 * and does not ask the legacy solver to re-solve a candidate.
 */
export function validateLoopPilotSolution(model: CompiledPuzzle, loop: LoopSegment[]): LoopPilotValidation {
  const active = new Set(model.board.activeCells);
  const errors: string[] = [];
  const selected = new Set<string>();
  const neighbors = new Map<CellId, Set<CellId>>(model.board.activeCells.map((cell) => [cell, new Set<CellId>()]));

  for (const segment of loop) {
    if (!active.has(segment.from) || !active.has(segment.to)) {
      errors.push(`edge leaves active topology: ${segment.from}-${segment.to}`);
      continue;
    }
    if (!areOrthogonal(segment.from, segment.to)) {
      errors.push(`edge is not orthogonal: ${segment.from}-${segment.to}`);
      continue;
    }
    const key = edgeKey(segment.from, segment.to);
    if (selected.has(key)) errors.push(`duplicate edge: ${key}`);
    selected.add(key);
    neighbors.get(segment.from)!.add(segment.to);
    neighbors.get(segment.to)!.add(segment.from);
  }

  const visited = new Set([...neighbors].filter(([, incident]) => incident.size > 0).map(([cell]) => cell));
  for (const cell of model.board.activeCells) {
    const degree = neighbors.get(cell)!.size;
    if (degree !== 0 && degree !== 2) errors.push(`degree is ${degree}, expected 0 or 2 at ${cell}`);
  }
  if (visited.size === 0) errors.push("solution has no visited cells");
  if (selected.size !== visited.size) errors.push(`edge/cell cardinality mismatch: ${selected.size} edges for ${visited.size} visited cells`);
  if (visited.size > 0) {
    const start = visited.values().next().value as CellId;
    const reached = new Set<CellId>([start]);
    const queue = [start];
    while (queue.length) {
      const cell = queue.shift()!;
      for (const neighbor of neighbors.get(cell)!) {
        if (!reached.has(neighbor)) {
          reached.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    if (reached.size !== visited.size) errors.push(`selected edges contain ${visited.size - reached.size} disconnected visited cells`);
  }

  const orientation = (cell: CellId, kind: "straight" | "turn") => {
    const [row, column] = parseCell(cell);
    const north = neighbors.get(cell)!.has(cellAt(row - 1, column));
    const east = neighbors.get(cell)!.has(cellAt(row, column + 1));
    const south = neighbors.get(cell)!.has(cellAt(row + 1, column));
    const west = neighbors.get(cell)!.has(cellAt(row, column - 1));
    const selectedNeighbors = [north ? cellAt(row - 1, column) : undefined, east ? cellAt(row, column + 1) : undefined, south ? cellAt(row + 1, column) : undefined, west ? cellAt(row, column - 1) : undefined].filter(Boolean) as CellId[];
    return selectedNeighbors.length === 2 && loopOrientationMatches(cell, selectedNeighbors[0]!, selectedNeighbors[1]!, kind);
  };

  const cellClues = new Set(model.board.clues.flatMap((clue) => {
    const cell = anchorCell(clue, active);
    return cell ? [cell] : [];
  }));
  for (const clue of model.board.clues) {
    if (hasRule(model, clue.kind, "loop.cell-dot.visited") || hasRule(model, clue.kind, "loop.white-dot.straight") || hasRule(model, clue.kind, "loop.black-dot.turn") || hasRule(model, clue.kind, "loop.cell-dot.straight") || hasRule(model, clue.kind, "loop.cell-dot.turn")) {
      const cell = anchorCell(clue, active);
      if (!cell) errors.push(`cell clue has invalid anchor: ${clue.id}`);
      else if (!visited.has(cell)) errors.push(`visited/orientation clue is unvisited: ${clue.id}`);
    }
    if (hasRule(model, clue.kind, "loop.cell-dot.unvisited")) {
      const cell = anchorCell(clue, active);
      if (!cell) errors.push(`unvisited clue has invalid anchor: ${clue.id}`);
      else if (visited.has(cell)) errors.push(`unvisited clue is visited: ${clue.id}`);
    }
    if (hasRule(model, clue.kind, "loop.white-dot.straight") || hasRule(model, clue.kind, "loop.cell-dot.straight")) {
      const cell = anchorCell(clue, active);
      if (cell && !orientation(cell, "straight")) errors.push(`straight clue turns: ${clue.id}`);
    }
    if (hasRule(model, clue.kind, "loop.black-dot.turn") || hasRule(model, clue.kind, "loop.cell-dot.turn")) {
      const cell = anchorCell(clue, active);
      if (cell && !orientation(cell, "turn")) errors.push(`turn clue goes straight: ${clue.id}`);
    }
    if (hasRule(model, clue.kind, "loop.edge-dot.traversed") || hasRule(model, clue.kind, "loop.edge-dot.not-traversed")) {
      const anchor = clueAnchorOf(clue);
      const cells = anchor?.kind === "edge" ? cellsTouchedByAnchor(anchor) : [];
      if (cells.length !== 2 || cells.some((cell) => !active.has(cell))) {
        errors.push(`edge clue has invalid topology: ${clue.id}`);
      } else {
        const used = selected.has(edgeKey(cells[0]!, cells[1]!));
        if (hasRule(model, clue.kind, "loop.edge-dot.traversed") && !used) errors.push(`traversed edge is absent: ${clue.id}`);
        if (hasRule(model, clue.kind, "loop.edge-dot.not-traversed") && used) errors.push(`not-traversed edge is present: ${clue.id}`);
      }
    }
  }
  if (model.globalRuleKeys.includes("loop.visit-all-unclued-cells")) {
    for (const cell of model.board.activeCells) if (!cellClues.has(cell) && !visited.has(cell)) errors.push(`unclued cell is not visited: ${cell}`);
  }

  return { valid: errors.length === 0, errors, signature: [...selected].sort().join("|") };
}

/**
 * Pure full-rule acceptance oracle shared by legacy and Z3 evidence.  It is
 * deliberately independent of the Z3 module.  The SMT encoder does not call
 * this function while searching; callers use it only to audit projected edge
 * assignments (and legacy uses the same final acceptance gate).
 */
export function validateLoopSolution(model: CompiledPuzzle, loop: LoopSegment[]): LoopPilotValidation {
  const base = validateLoopPilotSolution(model, loop);
  const errors = [...base.errors];
  if (errors.length) return { valid: false, errors, signature: base.signature };
  const active = new Set(model.board.activeCells);
  const selected = new Set(loop.map((segment) => edgeKey(segment.from, segment.to)));
  const neighbors = new Map<CellId, Set<CellId>>(model.board.activeCells.map((cell) => [cell, new Set<CellId>()]));
  for (const segment of loop) {
    neighbors.get(segment.from)!.add(segment.to);
    neighbors.get(segment.to)!.add(segment.from);
  }
  const visited = new Set([...neighbors].filter(([, incident]) => incident.size === 2).map(([cell]) => cell));
  const start = visited.values().next().value as CellId;
  const path: CellId[] = [];
  if (start) {
    let previous: CellId | undefined;
    let current: CellId = start;
    do {
      path.push(current);
      const next = [...neighbors.get(current)!].find((candidate) => candidate !== previous);
      previous = current;
      current = next!;
    } while (current && current !== start && path.length <= visited.size + 1);
  }
  if (path.length !== visited.size) return { valid: false, errors: [...errors, "cannot derive one cyclic path"], signature: base.signature };
  const position = new Map(path.map((cell, index) => [cell, index]));
  const isTurn = (cell: CellId) => {
    const index = position.get(cell);
    if (index === undefined) return false;
    return !loopIsStraight(cell, path[(index - 1 + path.length) % path.length]!, path[(index + 1) % path.length]!);
  };
  const orthogonal = (cell: CellId) => {
    const [row, column] = parseCell(cell);
    return [cellAt(row - 1, column), cellAt(row, column + 1), cellAt(row + 1, column), cellAt(row, column - 1)].filter((candidate) => active.has(candidate));
  };
  const surrounding = (cell: CellId) => {
    const [row, column] = parseCell(cell);
    const result: CellId[] = [];
    for (let rowStep = -1; rowStep <= 1; rowStep += 1) for (let columnStep = -1; columnStep <= 1; columnStep += 1) {
      if (rowStep || columnStep) { const candidate = cellAt(row + rowStep, column + columnStep); if (active.has(candidate)) result.push(candidate); }
    }
    return result;
  };
  const armLengths = (cell: CellId): [number, number] => {
    const index = position.get(cell);
    if (index === undefined) return [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    const walk = (step: -1 | 1) => { for (let distance = 1; distance <= path.length; distance += 1) if (isTurn(path[(index + step * distance + path.length * 2) % path.length]!)) return distance; return Number.POSITIVE_INFINITY; };
    return [walk(-1), walk(1)];
  };
  const edgeSideRuns = (cells: [CellId, CellId]): [number, number] | undefined => {
    const [left, right] = cells; const leftIndex = position.get(left); const rightIndex = position.get(right);
    if (leftIndex === undefined || rightIndex === undefined || !selected.has(edgeKey(left, right))) return undefined;
    const side = (at: number, across: number) => {
      if (isTurn(path[at]!)) return 0;
      const forward = (at + 1) % path.length === across; const step: -1 | 1 = forward ? -1 : 1;
      for (let distance = 1; distance < path.length; distance += 1) if (isTurn(path[(at + step * distance + path.length * 2) % path.length]!)) return distance;
      return Number.POSITIVE_INFINITY;
    };
    return [side(leftIndex, rightIndex), side(rightIndex, leftIndex)];
  };
  const outwardRun = (cell: CellId, rowStep: number, columnStep: number) => {
    let [row, column] = parseCell(cell); let length = 0;
    while (true) { const next = cellAt(row + rowStep, column + columnStep); if (!selected.has(edgeKey(cellAt(row, column), next))) return length; length += 1; row += rowStep; column += columnStep; }
  };
  const parallelSegments = (anchor: Extract<NonNullable<ReturnType<typeof clueAnchorOf>>, { kind: "exterior" }>) => {
    const horizontal = anchor.side === "left" || anchor.side === "right"; const starts: number[] = [];
    for (const cell of selected) { const [a, b] = cell.split("-") as [CellId, CellId]; const first = parseCell(a); const second = parseCell(b); if (horizontal && first[0] === anchor.index && second[0] === anchor.index) starts.push(Math.min(first[1], second[1])); if (!horizontal && first[1] === anchor.index && second[1] === anchor.index) starts.push(Math.min(first[0], second[0])); }
    starts.sort((a, b) => a - b); const lengths: number[] = []; for (let index = 0; index < starts.length; index += 1) { const start = starts[index]!; if (index === 0 || start !== starts[index - 1]! + 1) lengths.push(1); else lengths[lengths.length - 1] += 1; } return lengths;
  };
  const inside = (row: number, column: number) => {
    const polygon = path.map((cell) => { const [r, c] = parseCell(cell); return { x: c + 0.5, y: r + 0.5 }; }); let result = false;
    for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) { const current = polygon[index]!; const prior = polygon[previous]!; const hit = (current.y > row) !== (prior.y > row) && column < ((prior.x - current.x) * (row - current.y)) / (prior.y - current.y) + current.x; if (hit) result = !result; }
    return result;
  };
  const component = (cell: CellId) => {
    if (visited.has(cell)) return new Set<CellId>(); const result = new Set<CellId>([cell]); const queue = [cell];
    while (queue.length) { const current = queue.shift()!; for (const next of orthogonal(current)) if (!visited.has(next) && !result.has(next)) { result.add(next); queue.push(next); } }
    return result;
  };
  const has = (clue: ClueInstance, key: string) => model.clueRules.some((rule) => rule.clueKind === clue.kind && rule.key === key);
  const nonCountable = new Set(model.board.clues.flatMap((clue) => {
    const anchor = clueAnchorOf(clue);
    if (anchor?.kind !== "cell") return [];
    const blocked = ["loop.cell-number.orthogonal-unvisited", "loop.cell-number.eight-visited", "loop.cell-number.eight-turns", "loop.cell-number.eight-unvisited", "loop.cell-number.four-visited", "loop.cell-number.four-turns", "loop.cell-number.outward-segment-length-sum", "loop.cell-dot.unvisited", "loop.cell-dot.unvisited-component-center-symmetric", "loop.cell-dot.unvisited-component-axis-symmetric"].some((key) => has(clue, key));
    return blocked ? [anchor.cell] : [];
  }));
  const count = (cells: CellId[], predicate: (cell: CellId) => boolean) => cells.filter(predicate).length;
  if (model.globalRuleKeys.includes("loop.unvisited-not-adjacent")) for (const cell of active) for (const next of orthogonal(cell)) if (cell < next && !nonCountable.has(cell) && !nonCountable.has(next) && !visited.has(cell) && !visited.has(next)) errors.push("adjacent unvisited cells");
  if (model.globalRuleKeys.includes("loop.visit-all-unclued-cells")) {
    const clues = new Set(model.board.clues.flatMap((clue) => { const anchor = clueAnchorOf(clue); return anchor?.kind === "cell" ? [anchor.cell] : []; }));
    for (const cell of active) if (!clues.has(cell) && !visited.has(cell)) errors.push(`unclued cell is not visited: ${cell}`);
  }
  for (const clue of model.board.clues) {
    const anchor = clueAnchorOf(clue); const value = clue.value;
    if (!anchor) continue;
    if (anchor.kind === "cell") {
      const cell = anchor.cell; const ortho = orthogonal(cell); const around = surrounding(cell); const arms = armLengths(cell);
      const ordinaryUnvisited = (x: CellId) => !visited.has(x) && !nonCountable.has(x);
      if (has(clue, "loop.cell-number.orthogonal-unvisited") && (visited.has(cell) || count(ortho, ordinaryUnvisited) !== value)) errors.push(`orthogonal-unvisited: ${clue.id}`);
      if (has(clue, "loop.cell-number.eight-visited") && (visited.has(cell) || count(around, (x) => visited.has(x)) !== value)) errors.push(`eight-visited: ${clue.id}`);
      // eight-unvisited follows the legacy binaryClues meaning: every
      // neighboring cell that is not on the loop counts, including state-2
      // clue cells.  Only orthogonal-unvisited uses ordinaryUnvisited's
      // state-1-only interpretation.
      if (has(clue, "loop.cell-number.eight-unvisited") && (visited.has(cell) || count(around, (x) => !visited.has(x)) !== value)) errors.push(`eight-unvisited: ${clue.id}`);
      if (has(clue, "loop.cell-number.four-visited") && (visited.has(cell) || count(ortho, (x) => visited.has(x)) !== value)) errors.push(`four-visited: ${clue.id}`);
      if (has(clue, "loop.cell-number.eight-turns") && (visited.has(cell) || count(around, (x) => visited.has(x) && isTurn(x)) !== value)) errors.push(`eight-turns: ${clue.id}`);
      if (has(clue, "loop.cell-number.four-turns") && (visited.has(cell) || count(ortho, (x) => visited.has(x) && isTurn(x)) !== value)) errors.push(`four-turns: ${clue.id}`);
      if (has(clue, "loop.cell-number.inside-vertex-count")) { const [r, c] = parseCell(cell); if ([inside(r, c), inside(r + 1, c), inside(r, c + 1), inside(r + 1, c + 1)].filter(Boolean).length !== value) errors.push(`inside count: ${clue.id}`); }
      if (has(clue, "loop.cell-number.arm-length-sum") && (!visited.has(cell) || arms[0] + arms[1] !== value)) errors.push(`arm sum: ${clue.id}`);
      if (has(clue, "loop.cell-number.outward-segment-length-sum")) { const [r, c] = parseCell(cell); const actual = ortho.reduce((sum, next) => { const [nr, nc] = parseCell(next); return sum + outwardRun(next, nr - r, nc - c); }, 0); if (visited.has(cell) || actual !== value) errors.push(`outward cell: ${clue.id}`); }
      if (has(clue, "loop.cell-dot.equal-arm-lengths") && (!visited.has(cell) || arms[0] !== arms[1])) errors.push(`equal arms: ${clue.id}`);
      if (has(clue, "loop.cell-dot.unequal-arm-lengths") && (!visited.has(cell) || arms[0] === arms[1])) errors.push(`unequal arms: ${clue.id}`);
      if (has(clue, "loop.cell-dot.arm-length-difference-one") && (!visited.has(cell) || Math.abs(arms[0] - arms[1]) !== 1)) errors.push(`arm difference: ${clue.id}`);
      const index = position.get(cell); const before = index === undefined ? undefined : path[(index - 1 + path.length) % path.length]; const after = index === undefined ? undefined : path[(index + 1) % path.length];
      if ((has(clue, "loop.cell-dot.masyu-white") || has(clue, "loop.white-dot.straight")) && (!visited.has(cell) || isTurn(cell))) errors.push(`white orientation: ${clue.id}`);
      if (has(clue, "loop.cell-dot.masyu-white") && before && after && isTurn(before) === false && isTurn(after) === false) errors.push(`white arms: ${clue.id}`);
      if ((has(clue, "loop.cell-dot.masyu-black") || has(clue, "loop.black-dot.turn")) && (!visited.has(cell) || !isTurn(cell))) errors.push(`black orientation: ${clue.id}`);
      if (has(clue, "loop.cell-dot.masyu-black") && before && after && (isTurn(before) || isTurn(after))) errors.push(`black arms: ${clue.id}`);
      if (has(clue, "loop.cell-dot.pearl-black") && (!visited.has(cell) || !before || !after || !isTurn(before) || !isTurn(after))) errors.push(`black pearl: ${clue.id}`);
      if (has(clue, "loop.cell-dot.pearl-white") && (!visited.has(cell) || !before || !after || isTurn(before) || isTurn(after))) errors.push(`white pearl: ${clue.id}`);
      if (has(clue, "loop.cell-dot.unvisited-component-center-symmetric") || has(clue, "loop.cell-dot.unvisited-component-axis-symmetric")) {
        if (visited.has(cell)) errors.push(`symmetry clue is visited: ${clue.id}`); else { const members = component(cell); const [r, c] = parseCell(cell); const maps = has(clue, "loop.cell-dot.unvisited-component-center-symmetric") ? [(x: number, y: number) => cellAt(2 * r - x, 2 * c - y)] : [(x: number, y: number) => cellAt(x, 2 * c - y), (x: number, y: number) => cellAt(2 * r - x, y), (x: number, y: number) => cellAt(r + y - c, c + x - r), (x: number, y: number) => cellAt(r - y + c, c - x + r)]; if (!maps.some((map) => [...members].every((item) => { const [x, y] = parseCell(item); return members.has(map(x, y)); }))) errors.push(`component symmetry: ${clue.id}`); }
      }
    }
    if (anchor.kind === "edge") {
      const cells = cellsTouchedByAnchor(anchor) as [CellId, CellId]; const edge = cells.length === 2 && selected.has(edgeKey(cells[0]!, cells[1]!)); const sides = edgeSideRuns(cells); const counts = sides ? [sides[0] + 1, sides[1] + 1] : [0, 0];
      if (has(clue, "loop.edge-dot.traversed") !== edge && (has(clue, "loop.edge-dot.traversed") || has(clue, "loop.edge-dot.not-traversed"))) errors.push(`edge traversal: ${clue.id}`);
      if (has(clue, "loop.edge-dot.segment-midpoint") && (!edge || counts[0] !== counts[1])) errors.push(`edge midpoint: ${clue.id}`);
      if (has(clue, "loop.edge-dot.split-cell-count-difference-one") && (!edge || Math.abs(counts[0] - counts[1]) !== 1)) errors.push(`edge split difference: ${clue.id}`);
      if (has(clue, "loop.edge-dot.split-cell-count-ratio-two") && (!edge || (counts[0] !== 2 * counts[1] && counts[1] !== 2 * counts[0]))) errors.push(`edge split ratio: ${clue.id}`);
      if (has(clue, "loop.edge-dot.exactly-one-cell-visited") && count(cells, (x) => visited.has(x)) !== 1) errors.push(`edge exactly one: ${clue.id}`);
      if ((has(clue, "loop.edge-dot.same-cell-orientation") || has(clue, "loop.edge-dot.opposite-cell-orientation")) && (!cells.every((x) => visited.has(x)) || (isTurn(cells[0]!) === isTurn(cells[1]!)) !== has(clue, "loop.edge-dot.same-cell-orientation"))) errors.push(`edge orientation: ${clue.id}`);
      if (has(clue, "loop.edge-number.segment-length") && (!edge || sides![0] + sides![1] + 1 !== value)) errors.push(`edge segment: ${clue.id}`);
      if (has(clue, "loop.edge-number.visited-cell-count") && count(cells, (x) => visited.has(x)) !== value) errors.push(`edge visited count: ${clue.id}`);
      if (has(clue, "loop.edge-number.outward-segment-length-sum")) { const [a, b] = cells; const directions = anchor.orientation === "vertical" ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]]; const actual = outwardRun(a!, directions[0]![0]!, directions[0]![1]!) + outwardRun(b!, directions[1]![0]!, directions[1]![1]!); if (edge || actual !== value) errors.push(`edge outward: ${clue.id}`); }
    }
    if (anchor.kind === "vertex") {
      const cells = cellsTouchedByAnchor(anchor); const selectedEdges = [[cells[0], cells[1]], [cells[2], cells[3]], [cells[0], cells[2]], [cells[1], cells[3]]].filter(([a, b]) => a && b && selected.has(edgeKey(a, b))).length;
      if (has(clue, "loop.vertex-number.visited-cell-count") && count(cells, (x) => visited.has(x)) !== value) errors.push(`vertex visited count: ${clue.id}`);
      if (has(clue, "loop.vertex-number.turn-count") && count(cells, (x) => visited.has(x) && isTurn(x)) !== value) errors.push(`vertex turn count: ${clue.id}`);
      if (has(clue, "loop.vertex-number.used-edge-count") && selectedEdges !== value) errors.push(`vertex edge count: ${clue.id}`);
      if (has(clue, "loop.vertex-dot.inside") && !inside(anchor.row, anchor.column)) errors.push(`vertex inside: ${clue.id}`);
      if (has(clue, "loop.vertex-dot.outside") && inside(anchor.row, anchor.column)) errors.push(`vertex outside: ${clue.id}`);
      if (has(clue, "loop.vertex-dot.more-visited") && count(cells, (x) => visited.has(x)) <= 2) errors.push(`vertex majority visited: ${clue.id}`);
      if (has(clue, "loop.vertex-dot.more-unvisited") && count(cells, (x) => visited.has(x)) >= 2) errors.push(`vertex majority unvisited: ${clue.id}`);
    }
    if (anchor.kind === "exterior") {
      const observed = cellsObservedByExterior(model.board, anchor); const lengths = parallelSegments(anchor);
      if (has(clue, "loop.exterior-number.visited-cell-count") && count(observed, (x) => visited.has(x)) !== value) errors.push(`exterior visited count: ${clue.id}`);
      if (has(clue, "loop.exterior-number.parallel-segment-count") && lengths.length !== value) errors.push(`exterior segment count: ${clue.id}`);
      if (has(clue, "loop.exterior-number.longest-parallel-segment" ) && (lengths.length === 0 || Math.max(...lengths) !== value)) errors.push(`exterior longest: ${clue.id}`);
      if (has(clue, "loop.exterior-number.shortest-parallel-segment") && (lengths.length === 0 || Math.min(...lengths) !== value)) errors.push(`exterior shortest: ${clue.id}`);
    }
  }
  return { valid: errors.length === 0, errors, signature: base.signature };
}

/** Final legacy/Z3 pilot acceptance predicate; signature equality prevents a
 * caller from validating one edge set while inserting another. */
export function acceptLoopPilotCandidate(model: CompiledPuzzle, loop: LoopSegment[], expectedSignature: string): boolean {
  const validation = validateLoopSolution(model, loop);
  return validation.valid && validation.signature === expectedSignature;
}

export function loopSegmentsFromSignature(signature: string): LoopSegment[] {
  return signature.split("|").filter(Boolean).map((part) => {
    const separator = part.indexOf("-");
    return { from: part.slice(0, separator) as CellId, to: part.slice(separator + 1) as CellId };
  });
}

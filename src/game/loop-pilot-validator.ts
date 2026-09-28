import { cellsTouchedByAnchor, clueAnchorOf } from "./puzzle-model";
import type { LoopSegment } from "./puzzle-model";
import type { CellId } from "./types";
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

/** Final legacy/Z3 pilot acceptance predicate; signature equality prevents a
 * caller from validating one edge set while inserting another. */
export function acceptLoopPilotCandidate(model: CompiledPuzzle, loop: LoopSegment[], expectedSignature: string): boolean {
  const validation = validateLoopPilotSolution(model, loop);
  return validation.valid && validation.signature === expectedSignature;
}

export function loopSegmentsFromSignature(signature: string): LoopSegment[] {
  return signature.split("|").filter(Boolean).map((part) => {
    const separator = part.indexOf("-");
    return { from: part.slice(0, separator) as CellId, to: part.slice(separator + 1) as CellId };
  });
}

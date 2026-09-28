import type { CompiledPuzzle } from "./solver-model";
import type { BoardState, CellId, ClueInstance } from "./types";

export const LOOP_Z3_FIXTURE_SEED = "8x8-hamiltonian-serpentine-v1";

function cells(rows: number, columns: number): CellId[] {
  return Array.from({ length: rows * columns }, (_, index) => `${Math.floor(index / columns)}:${index % columns}` as CellId);
}

function boardClue(id: string, kind: ClueInstance["kind"], anchor: ClueInstance["anchor"]): ClueInstance {
  return { id, kind, anchor, sourceCardInstanceId: `fixture-${id}` };
}

/**
 * A deterministic Hamiltonian-cycle fixture. The cycle is used only to place
 * semantically consistent clue locations; no answer edge is asserted here.
 * The actual fixture has 64 active cells and combines visit-all-unclued,
 * straight/turn cell clues, and traversed/not-traversed edge clues.
 */
export function createLoopZ3BenchmarkFixture(timeBudgetMs = 2500): CompiledPuzzle {
  const activeCells = cells(8, 8);
  const clues: ClueInstance[] = [
    boardClue("white-0-3", "white-dot", { kind: "cell", cell: "0:3" }),
    boardClue("white-0-5", "white-dot", { kind: "cell", cell: "0:5" }),
    boardClue("white-2-3", "white-dot", { kind: "cell", cell: "2:3" }),
    boardClue("white-4-5", "white-dot", { kind: "cell", cell: "4:5" }),
    boardClue("white-6-3", "white-dot", { kind: "cell", cell: "6:3" }),
    boardClue("black-0-7", "black-dot", { kind: "cell", cell: "0:7" }),
    boardClue("black-1-7", "black-dot", { kind: "cell", cell: "1:7" }),
    boardClue("black-2-7", "black-dot", { kind: "cell", cell: "2:7" }),
    boardClue("black-3-7", "black-dot", { kind: "cell", cell: "3:7" }),
    boardClue("black-4-7", "black-dot", { kind: "cell", cell: "4:7" }),
    boardClue("black-5-7", "black-dot", { kind: "cell", cell: "5:7" }),
    boardClue("used-top", "edge-white-dot", { kind: "edge", orientation: "vertical", row: 0, column: 3 }),
    boardClue("used-row2", "edge-white-dot", { kind: "edge", orientation: "vertical", row: 2, column: 4 }),
    boardClue("used-row4", "edge-white-dot", { kind: "edge", orientation: "vertical", row: 4, column: 5 }),
    boardClue("unused-inner", "edge-black-dot", { kind: "edge", orientation: "horizontal", row: 1, column: 1 }),
    boardClue("unused-inner-2", "edge-black-dot", { kind: "edge", orientation: "horizontal", row: 2, column: 2 }),
  ];
  const clueRules: CompiledPuzzle["clueRules"] = [
    { key: "loop.white-dot.straight", clueKind: "white-dot", sourceCardInstanceId: "fixture-white" },
    { key: "loop.black-dot.turn", clueKind: "black-dot", sourceCardInstanceId: "fixture-black" },
    { key: "loop.edge-dot.traversed", clueKind: "edge-white-dot", sourceCardInstanceId: "fixture-edge-white" },
    { key: "loop.edge-dot.not-traversed", clueKind: "edge-black-dot", sourceCardInstanceId: "fixture-edge-black" },
  ];
  const board: BoardState = {
    id: "loop-z3-8x8-benchmark",
    name: "loop-z3-8x8-benchmark",
    rows: 8,
    columns: 8,
    activeCells,
    ruleCapacity: 20,
    mechanic: "loop",
    globalCards: [{ instanceId: "fixture-global", definitionId: "rule-loop-visit-all-unclued" }],
    clueCards: [],
    clues,
    draftStrokes: [],
    revision: 0,
  };
  return {
    board,
    mechanic: "loop",
    globalRuleKeys: ["loop.single-cycle", "loop.visit-all-unclued-cells"],
    clueRules,
    solutionLimit: 2,
    timeBudgetMs,
  };
}

export function createLoopZ3Model(options: {
  rows: number;
  columns: number;
  clues?: ClueInstance[];
  globalRuleKeys?: string[];
  clueRules?: CompiledPuzzle["clueRules"];
  activeCells?: CellId[];
  timeBudgetMs?: number;
  name?: string;
}): CompiledPuzzle {
  const rows = options.rows;
  const columns = options.columns;
  const name = options.name ?? `loop-z3-${rows}x${columns}`;
  const board: BoardState = {
    id: name,
    name,
    rows,
    columns,
    activeCells: options.activeCells ?? cells(rows, columns),
    ruleCapacity: 20,
    mechanic: "loop",
    globalCards: [],
    clueCards: [],
    clues: options.clues ?? [],
    draftStrokes: [],
    revision: 0,
  };
  return {
    board,
    mechanic: "loop",
    globalRuleKeys: ["loop.single-cycle", ...(options.globalRuleKeys ?? [])],
    clueRules: options.clueRules ?? [],
    solutionLimit: 2,
    timeBudgetMs: options.timeBudgetMs ?? 2500,
  };
}

export function fixtureCellClue(id: string, kind: ClueInstance["kind"], cell: CellId): ClueInstance {
  return boardClue(id, kind, { kind: "cell", cell });
}

export function fixtureEdgeClue(id: string, kind: ClueInstance["kind"], anchor: Extract<NonNullable<ClueInstance["anchor"]>, { kind: "edge" }>): ClueInstance {
  return boardClue(id, kind, anchor);
}

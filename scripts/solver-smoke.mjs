import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";

const output = mkdtempSync(join(tmpdir(), "ppd-solver-"));
await build({
  logLevel: "silent",
  build: {
    ssr: "scripts/solver-smoke-entry.ts",
    outDir: output,
    emptyOutDir: true,
  },
});
const entry = readdirSync(output).find((name) => name === "solver-smoke-entry.js");
if (!entry) throw new Error("Solver smoke build did not produce solver-smoke-entry.js");
const {
  auditSolverCoverage,
  canRemoveCell,
  cellsObservedByExterior,
  clueAnchorOf,
  compileBoard,
  evaluateBoard,
  createInitialGame,
  gameReducer,
  validateRegionPartition,
} = await import(pathToFileURL(join(output, entry)).href);

let reducerState = createInitialGame();
reducerState = gameReducer(reducerState, { type: "choose-start-board", boardId: "small" });
reducerState = gameReducer(reducerState, { type: "set-pending-clue-value", value: 9 });
reducerState = gameReducer(reducerState, { type: "place-pending-clue", anchor: { kind: "cell", cell: "0:0" } });
assert(reducerState.boards.find((item) => item.id === "small")?.clues.some((clue) => clue.value === 9), "A max=4 numeric clue must place value 9");
for (const invalid of [10, -1, 1.5]) {
  const before = reducerState;
  const pending = gameReducer({ ...before, pending: { kind: "place-clue", boardId: "small", card: { id: "regression", definitionId: "clue-cell-number" }, fromSetup: false, value: 0 } }, { type: "set-pending-clue-value", value: invalid });
  assert(pending.pending?.kind === "place-clue" && pending.pending.value === 0, `Reducer must reject numeric clue value ${invalid}`);
}

const cells = (rows, columns) => Array.from(
  { length: rows * columns },
  (_, index) => `${Math.floor(index / columns)}:${index % columns}`,
);

function board({
  name,
  rows,
  columns,
  globalId,
  clueCards = [],
  clues = [],
  activeCells = cells(rows, columns),
  mechanic = "loop",
}) {
  return {
    id: name,
    name,
    rows,
    columns,
    activeCells,
    ruleCapacity: 20,
    mechanic,
    globalCards: [{ instanceId: `global-${name}`, definitionId: globalId }],
    clueCards,
    clues,
    revision: 0,
  };
}

function pointCase(name, kind, definitionId) {
  return board({
    name,
    rows: 2,
    columns: 2,
    globalId: "rule-single-loop",
    clueCards: [{ instanceId: "point-card", definitionId, placedClueId: "point" }],
    clues: [{
      id: "point",
      kind,
      anchor: { kind: "cell", cell: "0:0" },
      value: 0,
      sourceCardInstanceId: "point-card",
    }],
  });
}

function shadeNumber(value) {
  return board({
    name: `shade-${value}`,
    rows: 1,
    columns: 1,
    globalId: "rule-shade-connected",
    mechanic: "shade",
    clueCards: [{ instanceId: "number-card", definitionId: "clue-cell-number", placedClueId: "number" }],
    clues: [{
      id: "number",
      kind: "cell-number",
      anchor: { kind: "cell", cell: "0:0" },
      value,
      sourceCardInstanceId: "number-card",
    }],
  });
}

function shadeNumberRule({ name, definitionId, value, rows, columns, position, activeCells, globalId = "rule-shade-connected" }) {
  return board({
    name,
    rows,
    columns,
    globalId,
    mechanic: "shade",
    activeCells: activeCells ?? cells(rows, columns),
    clueCards: [{ instanceId: `${name}-number-card`, definitionId, placedClueId: `${name}-number` }],
    clues: [{
      id: `${name}-number`,
      kind: "cell-number",
      anchor: { kind: "cell", cell: position },
      value,
      sourceCardInstanceId: `${name}-number-card`,
    }],
  });
}

function koburinNumber(value) {
  return board({
    name: `koburin-${value}`,
    rows: 4,
    columns: 4,
    globalId: "rule-koburin-open-cells-separate",
    clueCards: [{ instanceId: "koburin-card", definitionId: "clue-cell-number", placedClueId: "koburin-clue" }],
    clues: [{ id: "koburin-clue", kind: "cell-number", cellId: "1:1", value, sourceCardInstanceId: "koburin-card" }],
  });
}

function loopCellNumberRule(name, definitionId, value) {
  return board({
    name,
    rows: 3,
    columns: 3,
    globalId: "rule-single-loop",
    clueCards: [{ instanceId: `${name}-card`, definitionId, placedClueId: `${name}-clue` }],
    clues: [{
      id: `${name}-clue`,
      kind: "cell-number",
      anchor: { kind: "cell", cell: "1:1" },
      value,
      sourceCardInstanceId: `${name}-card`,
    }],
  });
}

function loopAnchoredRule({ name, rows, columns, definitionId, kind, anchor, value, activeCells, globalId = "rule-single-loop" }) {
  return board({
    name,
    rows,
    columns,
    globalId,
    activeCells: activeCells ?? cells(rows, columns),
    clueCards: [{ instanceId: `${name}-card`, definitionId, placedClueId: `${name}-clue` }],
    clues: [{ id: `${name}-clue`, kind, anchor, value, sourceCardInstanceId: `${name}-card` }],
  });
}

function fixedNumberRuleCase({ name, values, definitionId, kind, anchor, value = 0, extraTargets = [], globalId = "rule-number-connected" }) {
  const rows = values.length;
  const columns = values[0].length;
  const fixed = [];
  const empty = [];
  for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
    const cell = `${row}:${column}`;
    if (values[row][column] === 0) empty.push(cell);
    else fixed.push({ cell, value: values[row][column] });
  }
  const targets = [{ definitionId, kind, anchor, value }, ...extraTargets];
  return board({
    name,
    rows,
    columns,
    globalId,
    mechanic: "number",
    clueCards: [
      ...fixed.map((item, index) => ({ instanceId: `${name}-fixed-card-${index}`, definitionId: "clue-cell-number", placedClueId: `${name}-fixed-${index}` })),
      ...empty.map((cell, index) => ({ instanceId: `${name}-empty-card-${index}`, definitionId: "clue-number-cell-dot-empty-black", placedClueId: `${name}-empty-${index}` })),
      ...targets.map((target, index) => ({ instanceId: `${name}-target-card-${index}`, definitionId: target.definitionId, placedClueId: `${name}-target-${index}` })),
    ],
    clues: [
      ...fixed.map((item, index) => ({ id: `${name}-fixed-${index}`, kind: "cell-number", anchor: { kind: "cell", cell: item.cell }, value: item.value, sourceCardInstanceId: `${name}-fixed-card-${index}` })),
      ...empty.map((cell, index) => ({ id: `${name}-empty-${index}`, kind: "black-dot", anchor: { kind: "cell", cell }, value: 0, sourceCardInstanceId: `${name}-empty-card-${index}` })),
      ...targets.map((target, index) => ({ id: `${name}-target-${index}`, kind: target.kind, anchor: target.anchor, value: target.value, sourceCardInstanceId: `${name}-target-card-${index}` })),
    ],
  });
}

function constrainedShade({ name, rows, columns, globalId, black = [], white = [], activeCells }) {
  const clueCards = [];
  if (black.length) clueCards.push({ instanceId: `${name}-black-card`, definitionId: "clue-black-dot", placedClueId: `${name}-black-0` });
  if (white.length) clueCards.push({ instanceId: `${name}-white-card`, definitionId: "clue-white-dot", placedClueId: `${name}-white-0` });
  return board({
    name,
    rows,
    columns,
    globalId,
    mechanic: "shade",
    activeCells: activeCells ?? cells(rows, columns),
    clueCards,
    clues: [
      ...black.map((cell, index) => ({
        id: `${name}-black-${index}`,
        kind: "black-dot",
        anchor: { kind: "cell", cell },
        sourceCardInstanceId: `${name}-black-card`,
      })),
      ...white.map((cell, index) => ({
        id: `${name}-white-${index}`,
        kind: "white-dot",
        anchor: { kind: "cell", cell },
        sourceCardInstanceId: `${name}-white-card`,
      })),
    ],
  });
}

function kurottoCase({ name, rows, columns, position, value, black, white = [] }) {
  const clueCards = [
    { instanceId: `${name}-number-card`, definitionId: "clue-shade-cell-number-kurotto", placedClueId: `${name}-number` },
    { instanceId: `${name}-black-card`, definitionId: "clue-black-dot", placedClueId: `${name}-black-0` },
  ];
  if (white.length) clueCards.push({ instanceId: `${name}-white-card`, definitionId: "clue-white-dot", placedClueId: `${name}-white-0` });
  return board({
    name,
    rows,
    columns,
    globalId: "rule-shade-no-black-2x2",
    mechanic: "shade",
    clueCards,
    clues: [
      {
        id: `${name}-number`,
        kind: "cell-number",
        anchor: { kind: "cell", cell: position },
        value,
        sourceCardInstanceId: `${name}-number-card`,
      },
      ...black.map((cell, index) => ({
        id: `${name}-black-${index}`,
        kind: "black-dot",
        anchor: { kind: "cell", cell },
        sourceCardInstanceId: `${name}-black-card`,
      })),
      ...white.map((cell, index) => ({
        id: `${name}-white-${index}`,
        kind: "white-dot",
        anchor: { kind: "cell", cell },
        sourceCardInstanceId: `${name}-white-card`,
      })),
    ],
  });
}

function anchoredShadeCountCase({ name, rows, columns, definitionId, kind, anchor, value, black, white, activeCells }) {
  const clueCards = [
    { instanceId: `${name}-number-card`, definitionId, placedClueId: `${name}-number` },
    { instanceId: `${name}-black-card`, definitionId: "clue-black-dot", placedClueId: `${name}-black-0` },
    { instanceId: `${name}-white-card`, definitionId: "clue-white-dot", placedClueId: `${name}-white-0` },
  ];
  return board({
    name,
    rows,
    columns,
    globalId: "rule-shade-no-black-2x2",
    mechanic: "shade",
    activeCells: activeCells ?? cells(rows, columns),
    clueCards,
    clues: [
      {
        id: `${name}-number`,
        kind,
        anchor,
        value,
        sourceCardInstanceId: `${name}-number-card`,
      },
      ...black.map((cell, index) => ({
        id: `${name}-black-${index}`,
        kind: "black-dot",
        anchor: { kind: "cell", cell },
        sourceCardInstanceId: `${name}-black-card`,
      })),
      ...white.map((cell, index) => ({
        id: `${name}-white-${index}`,
        kind: "white-dot",
        anchor: { kind: "cell", cell },
        sourceCardInstanceId: `${name}-white-card`,
      })),
    ],
  });
}

function cellDotRuleCase({ name, rows, columns, definitionId, position, white }) {
  const allCells = cells(rows, columns);
  const whiteSet = new Set(white);
  const black = allCells.filter((cell) => !whiteSet.has(cell));
  const blackSet = new Set(black);
  const orthogonal = (cell) => {
    const [row, column] = cell.split(":").map(Number);
    return [`${row - 1}:${column}`, `${row + 1}:${column}`, `${row}:${column - 1}`, `${row}:${column + 1}`]
      .filter((neighbor) => allCells.includes(neighbor));
  };
  return board({
    name,
    rows,
    columns,
    globalId: "rule-shade-no-white-2x2",
    mechanic: "shade",
    clueCards: [
      { instanceId: `${name}-dot-card`, definitionId, placedClueId: `${name}-dot` },
      { instanceId: `${name}-number-card`, definitionId: "clue-shade-cell-number-orthogonal", placedClueId: `${name}-white-0` },
      { instanceId: `${name}-black-card`, definitionId: "clue-black-dot", placedClueId: `${name}-black-0` },
    ],
    clues: [
      {
        id: `${name}-dot`,
        kind: "white-dot",
        anchor: { kind: "cell", cell: position },
        sourceCardInstanceId: `${name}-dot-card`,
      },
      ...white.map((cell, index) => ({
        id: `${name}-white-${index}`,
        kind: "cell-number",
        anchor: { kind: "cell", cell },
        value: orthogonal(cell).filter((neighbor) => blackSet.has(neighbor)).length,
        sourceCardInstanceId: `${name}-number-card`,
      })),
      ...black.map((cell, index) => ({
        id: `${name}-black-${index}`,
        kind: "black-dot",
        anchor: { kind: "cell", cell },
        sourceCardInstanceId: `${name}-black-card`,
      })),
    ],
  });
}

function anchoredDotRuleCase({ name, rows, columns, definitionId, kind, anchor, white }) {
  const allCells = cells(rows, columns);
  const whiteSet = new Set(white);
  const black = allCells.filter((cell) => !whiteSet.has(cell));
  const blackSet = new Set(black);
  const orthogonal = (cell) => {
    const [row, column] = cell.split(":").map(Number);
    return [`${row - 1}:${column}`, `${row + 1}:${column}`, `${row}:${column - 1}`, `${row}:${column + 1}`]
      .filter((neighbor) => allCells.includes(neighbor));
  };
  return board({
    name,
    rows,
    columns,
    globalId: "rule-shade-no-white-2x2",
    mechanic: "shade",
    clueCards: [
      { instanceId: `${name}-anchor-card`, definitionId, placedClueId: `${name}-anchor` },
      { instanceId: `${name}-number-card`, definitionId: "clue-shade-cell-number-orthogonal", placedClueId: `${name}-white-0` },
      { instanceId: `${name}-black-card`, definitionId: "clue-black-dot", placedClueId: `${name}-black-0` },
    ],
    clues: [
      { id: `${name}-anchor`, kind, anchor, sourceCardInstanceId: `${name}-anchor-card` },
      ...white.map((cell, index) => ({
        id: `${name}-white-${index}`,
        kind: "cell-number",
        anchor: { kind: "cell", cell },
        value: orthogonal(cell).filter((neighbor) => blackSet.has(neighbor)).length,
        sourceCardInstanceId: `${name}-number-card`,
      })),
      ...black.map((cell, index) => ({
        id: `${name}-black-${index}`,
        kind: "black-dot",
        anchor: { kind: "cell", cell },
        sourceCardInstanceId: `${name}-black-card`,
      })),
    ],
  });
}

const cases = [
  [board({ name: "region-rectangle-1x1", rows: 1, columns: 1, globalId: "rule-region-rectangles", mechanic: "region" }), "unique"],
  [board({ name: "number-latin-full-1x1", rows: 1, columns: 1, globalId: "rule-number-latin-full", mechanic: "number" }), "unique"],
  [board({ name: "number-latin-minus-one", rows: 2, columns: 2, globalId: "rule-number-latin-minus-one", mechanic: "number" }), "multiple"],
  [board({ name: "number-latin-minus-two", rows: 3, columns: 3, globalId: "rule-number-latin-minus-two", mechanic: "number" }), "multiple"],
  [fixedNumberRuleCase({ name: "number-connected", values: [[1, 2]], definitionId: "clue-cell-number", kind: "cell-number", anchor: { kind: "cell", cell: "0:0" }, value: 1 }), "unique"],
  [fixedNumberRuleCase({ name: "number-fixed-cell", values: [[1]], definitionId: "clue-cell-number", kind: "cell-number", anchor: { kind: "cell", cell: "0:0" }, value: 1 }), "unique"],
  [fixedNumberRuleCase({ name: "number-edge-sum", values: [[1, 2], [2, 1]], definitionId: "clue-number-edge-sum", kind: "edge-number", anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 }, value: 3 }), "unique"],
  [fixedNumberRuleCase({ name: "number-edge-difference", values: [[1, 2], [2, 1]], definitionId: "clue-number-edge-difference", kind: "edge-number", anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 }, value: 1 }), "unique"],
  [fixedNumberRuleCase({ name: "number-edge-product", values: [[1, 2], [2, 1]], definitionId: "clue-number-edge-product", kind: "edge-number", anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 }, value: 2 }), "unique"],
  [fixedNumberRuleCase({ name: "number-edge-contains", values: [[1, 2], [2, 1]], definitionId: "clue-number-edge-contains", kind: "edge-number", anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 }, value: 2 }), "unique"],
  [fixedNumberRuleCase({ name: "number-edge-arithmetic", values: [[1, 2], [2, 1]], definitionId: "clue-number-edge-arithmetic", kind: "edge-number", anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 }, value: 2 }), "unique"],
  [fixedNumberRuleCase({ name: "number-vertex-sum", values: [[1, 2], [2, 1]], definitionId: "clue-number-vertex-sum", kind: "vertex-number", anchor: { kind: "vertex", row: 1, column: 1 }, value: 6 }), "unique"],
  [fixedNumberRuleCase({ name: "number-vertex-contains", values: [[1, 2], [2, 1]], definitionId: "clue-number-vertex-contains", kind: "vertex-number", anchor: { kind: "vertex", row: 1, column: 1 }, value: 2 }), "unique"],
  [fixedNumberRuleCase({ name: "number-diagonal-sums", values: [[1, 2, 1, 2], [3, 4, 3, 4], [1, 2, 1, 2], [3, 4, 3, 4]], definitionId: "clue-number-vertex-diagonal-sums", kind: "vertex-number", anchor: { kind: "vertex", row: 1, column: 1 }, value: 5 }), "unique"],
  [fixedNumberRuleCase({ name: "number-diagonal-differences", values: [[1, 2], [2, 1]], definitionId: "clue-number-vertex-diagonal-differences", kind: "vertex-number", anchor: { kind: "vertex", row: 1, column: 1 }, value: 0 }), "unique"],
  [fixedNumberRuleCase({ name: "number-diagonal-arithmetic", values: [[1, 2, 1, 2], [3, 4, 3, 4], [1, 2, 1, 2], [3, 4, 3, 4]], definitionId: "clue-number-vertex-diagonal-arithmetic", kind: "vertex-number", anchor: { kind: "vertex", row: 1, column: 1 }, value: 5 }), "unique"],
  [fixedNumberRuleCase({ name: "number-cell-empty", values: [[0, 1], [1, 2]], definitionId: "clue-number-cell-dot-empty-black", kind: "black-dot", anchor: { kind: "cell", cell: "0:0" } }), "unique"],
  [fixedNumberRuleCase({ name: "number-cell-filled", values: [[1, 2], [2, 1]], definitionId: "clue-number-cell-dot-filled-white", kind: "white-dot", anchor: { kind: "cell", cell: "0:0" } }), "unique"],
  [fixedNumberRuleCase({ name: "number-cell-odd", values: [[1, 2], [2, 1]], definitionId: "clue-number-cell-dot-odd-white", kind: "white-dot", anchor: { kind: "cell", cell: "0:0" } }), "unique"],
  [fixedNumberRuleCase({ name: "number-cell-even", values: [[1, 2], [2, 1]], definitionId: "clue-number-cell-dot-even-black", kind: "black-dot", anchor: { kind: "cell", cell: "0:1" } }), "unique"],
  [fixedNumberRuleCase({ name: "number-cell-same-color", values: [[1, 2, 3], [2, 3, 1], [3, 1, 2]], definitionId: "clue-number-cell-dot-same-color-equal-white", kind: "white-dot", anchor: { kind: "cell", cell: "0:0" }, extraTargets: [{ definitionId: "clue-number-cell-dot-same-color-equal-white", kind: "white-dot", anchor: { kind: "cell", cell: "1:2" }, value: 0 }] }), "unique"],
  [fixedNumberRuleCase({ name: "number-cell-greater", values: [[1, 2, 1], [2, 3, 2], [1, 2, 1]], definitionId: "clue-number-cell-dot-greater-black", kind: "black-dot", anchor: { kind: "cell", cell: "1:1" } }), "unique"],
  [fixedNumberRuleCase({ name: "number-cell-less", values: [[1, 2], [2, 1]], definitionId: "clue-number-cell-dot-less-white", kind: "white-dot", anchor: { kind: "cell", cell: "0:0" } }), "unique"],
  [fixedNumberRuleCase({ name: "number-edge-both-filled", values: [[1, 2], [2, 1]], definitionId: "clue-number-edge-dot-both-filled-black", kind: "edge-black-dot", anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 } }), "unique"],
  [fixedNumberRuleCase({ name: "number-edge-one-filled", values: [[1, 0], [2, 1]], definitionId: "clue-number-edge-dot-one-filled-white", kind: "edge-white-dot", anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 } }), "unique"],
  [fixedNumberRuleCase({ name: "number-edge-both-empty", values: [[0, 0], [1, 2]], definitionId: "clue-number-edge-dot-both-empty-white", kind: "edge-white-dot", anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 } }), "unique"],
  [fixedNumberRuleCase({ name: "number-edge-difference-one-dot", values: [[1, 2], [2, 1]], definitionId: "clue-number-edge-dot-difference-one-white", kind: "edge-white-dot", anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 } }), "unique"],
  [fixedNumberRuleCase({ name: "number-edge-ratio-two-dot", values: [[1, 2], [2, 1]], definitionId: "clue-number-edge-dot-ratio-two-black", kind: "edge-black-dot", anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 } }), "unique"],
  [fixedNumberRuleCase({ name: "number-edge-sum-five-dot", values: [[2, 3, 1], [3, 1, 2], [1, 2, 3]], definitionId: "clue-number-edge-dot-sum-five-white", kind: "edge-white-dot", anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 } }), "unique"],
  [fixedNumberRuleCase({ name: "number-edge-sum-ten-dot", values: [[4, 6, 1, 2, 3, 5], [5, 4, 6, 1, 2, 3]], definitionId: "clue-number-edge-dot-sum-ten-black", kind: "edge-black-dot", anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 } }), "unique"],
  [fixedNumberRuleCase({ name: "number-edge-same-color-sums", values: [[1, 2, 1], [2, 1, 2]], definitionId: "clue-number-edge-dot-same-color-sums-white", kind: "edge-white-dot", anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 }, extraTargets: [{ definitionId: "clue-number-edge-dot-same-color-sums-white", kind: "edge-white-dot", anchor: { kind: "edge", orientation: "vertical", row: 0, column: 2 }, value: 0 }] }), "unique"],
  [fixedNumberRuleCase({ name: "number-vertex-more-even", values: [[2, 1, 2, 1], [4, 2, 4, 2], [2, 1, 2, 1], [4, 2, 4, 2]], definitionId: "clue-number-vertex-dot-more-even-black", kind: "vertex-black-dot", anchor: { kind: "vertex", row: 1, column: 1 } }), "unique"],
  [fixedNumberRuleCase({ name: "number-vertex-more-odd", values: [[1, 2, 1, 2], [3, 1, 3, 1], [1, 2, 1, 2], [3, 1, 3, 1]], definitionId: "clue-number-vertex-dot-more-odd-white", kind: "vertex-white-dot", anchor: { kind: "vertex", row: 1, column: 1 } }), "unique"],
  [fixedNumberRuleCase({ name: "number-vertex-more-empty", values: [[0, 0], [0, 1]], definitionId: "clue-number-vertex-dot-more-empty-white", kind: "vertex-white-dot", anchor: { kind: "vertex", row: 1, column: 1 } }), "unique"],
  [fixedNumberRuleCase({ name: "number-vertex-more-filled", values: [[1, 2], [2, 0]], definitionId: "clue-number-vertex-dot-more-filled-black", kind: "vertex-black-dot", anchor: { kind: "vertex", row: 1, column: 1 } }), "unique"],
  [fixedNumberRuleCase({ name: "number-clockwise", values: [[1, 2, 1, 2], [4, 3, 4, 3], [1, 2, 1, 2], [4, 3, 4, 3]], definitionId: "clue-number-vertex-dot-clockwise-white", kind: "vertex-white-dot", anchor: { kind: "vertex", row: 1, column: 1 } }), "unique"],
  [fixedNumberRuleCase({ name: "number-counterclockwise", values: [[1, 4, 1, 4], [2, 3, 2, 3], [1, 4, 1, 4], [2, 3, 2, 3]], definitionId: "clue-number-vertex-dot-counterclockwise-black", kind: "vertex-black-dot", anchor: { kind: "vertex", row: 1, column: 1 } }), "unique"],
  [fixedNumberRuleCase({ name: "number-one-consecutive-pair", values: [[1, 4, 1, 4], [4, 2, 4, 2], [1, 4, 1, 4], [4, 2, 4, 2]], definitionId: "clue-number-vertex-dot-one-consecutive-white", kind: "vertex-white-dot", anchor: { kind: "vertex", row: 1, column: 1 } }), "unique"],
  [fixedNumberRuleCase({ name: "number-two-consecutive-pairs", values: [[1, 2, 1, 2], [3, 4, 3, 4], [1, 2, 1, 2], [3, 4, 3, 4]], definitionId: "clue-number-vertex-dot-two-consecutive-black", kind: "vertex-black-dot", anchor: { kind: "vertex", row: 1, column: 1 } }), "unique"],
  [fixedNumberRuleCase({ name: "number-exterior-first", values: [[2, 1, 3], [1, 3, 2], [3, 2, 1]], definitionId: "clue-number-exterior-first", kind: "exterior-number", anchor: { kind: "exterior", side: "left", index: 0 }, value: 2 }), "unique"],
  [fixedNumberRuleCase({ name: "number-exterior-skyscraper-count", values: [[2, 1, 3], [1, 3, 2], [3, 2, 1]], definitionId: "clue-number-exterior-skyscraper-count", kind: "exterior-number", anchor: { kind: "exterior", side: "left", index: 0 }, value: 2 }), "unique"],
  [fixedNumberRuleCase({ name: "number-exterior-skyscraper-sum", values: [[2, 1, 3], [1, 3, 2], [3, 2, 1]], definitionId: "clue-number-exterior-skyscraper-sum", kind: "exterior-number", anchor: { kind: "exterior", side: "left", index: 0 }, value: 5 }), "unique"],
  [fixedNumberRuleCase({ name: "number-exterior-first-two", values: [[2, 1, 3], [1, 3, 2], [3, 2, 1]], definitionId: "clue-number-exterior-first-two", kind: "exterior-number", anchor: { kind: "exterior", side: "left", index: 0 }, value: 1 }), "unique"],
  [board({ name: "2x2-single", rows: 2, columns: 2, globalId: "rule-single-loop" }), "unique"],
  [board({ name: "3x3-multiple", rows: 3, columns: 3, globalId: "rule-single-loop" }), "multiple"],
  [pointCase("white-straight", "white-dot", "clue-white-dot"), "unsat"],
  [pointCase("black-turn", "black-dot", "clue-black-dot"), "unique"],
  [shadeNumber(0), "unique"],
  [shadeNumber(1), "unique"],
  [shadeNumberRule({
    name: "shade-orthogonal-number",
    definitionId: "clue-shade-cell-number-orthogonal",
    value: 1,
    rows: 1,
    columns: 2,
    position: "0:0",
  }), "unique"],
  [shadeNumberRule({
    name: "shade-plus-self-number",
    definitionId: "clue-shade-cell-number-plus-self",
    value: 1,
    rows: 1,
    columns: 1,
    position: "0:0",
  }), "unique"],
  [shadeNumberRule({
    name: "shade-eight-neighbor-number",
    definitionId: "clue-shade-cell-number-surrounding-eight",
    value: 1,
    rows: 1,
    columns: 2,
    position: "0:0",
  }), "unique"],
  [shadeNumberRule({
    name: "shade-orthogonal-irregular",
    definitionId: "clue-shade-cell-number-orthogonal",
    value: 2,
    rows: 2,
    columns: 2,
    position: "0:0",
    activeCells: ["0:0", "0:1", "1:0"],
    globalId: "rule-shade-no-black-2x2",
  }), "unique"],
  [shadeNumberRule({
    name: "shade-canal-view",
    definitionId: "clue-shade-cell-number-canal-view",
    value: 1,
    rows: 1,
    columns: 3,
    position: "0:0",
  }), "unique"],
  [shadeNumberRule({
    name: "shade-canal-view-gap",
    definitionId: "clue-shade-cell-number-canal-view",
    value: 1,
    rows: 1,
    columns: 3,
    position: "0:0",
    activeCells: ["0:0", "0:2"],
    globalId: "rule-shade-no-black-2x2",
  }), "unsat"],
  [shadeNumberRule({
    name: "shade-white-component",
    definitionId: "clue-shade-cell-number-white-component",
    value: 2,
    rows: 1,
    columns: 3,
    position: "0:0",
  }), "unique"],
  [shadeNumberRule({
    name: "shade-white-component-gap",
    definitionId: "clue-shade-cell-number-white-component",
    value: 2,
    rows: 1,
    columns: 3,
    position: "0:0",
    activeCells: ["0:0", "0:2"],
    globalId: "rule-shade-no-black-2x2",
  }), "unsat"],
  [shadeNumberRule({
    name: "shade-kurodoko",
    definitionId: "clue-shade-cell-number-kurodoko",
    value: 2,
    rows: 1,
    columns: 3,
    position: "0:0",
  }), "unique"],
  [shadeNumberRule({
    name: "shade-kurodoko-gap",
    definitionId: "clue-shade-cell-number-kurodoko",
    value: 2,
    rows: 1,
    columns: 3,
    position: "0:0",
    activeCells: ["0:0", "0:2"],
    globalId: "rule-shade-no-black-2x2",
  }), "unsat"],
  [kurottoCase({
    name: "shade-kurotto-components",
    rows: 1,
    columns: 4,
    position: "0:1",
    value: 3,
    black: ["0:0", "0:2", "0:3"],
  }), "unique"],
  [kurottoCase({
    name: "shade-kurotto-diagonal-contact",
    rows: 2,
    columns: 2,
    position: "0:0",
    value: 1,
    black: ["1:1"],
    white: ["0:1", "1:0"],
  }), "unique"],
  [anchoredShadeCountCase({
    name: "shade-edge-number-count",
    rows: 1,
    columns: 2,
    definitionId: "clue-shade-edge-number-count",
    kind: "edge-number",
    anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 },
    value: 1,
    black: ["0:0"],
    white: ["0:1"],
  }), "unique"],
  [anchoredShadeCountCase({
    name: "shade-edge-component-sum",
    rows: 1,
    columns: 5,
    definitionId: "clue-shade-edge-number-component-sum",
    kind: "edge-number",
    anchor: { kind: "edge", orientation: "vertical", row: 0, column: 2 },
    value: 5,
    black: ["0:0", "0:1"],
    white: ["0:2", "0:3", "0:4"],
  }), "unique"],
  [anchoredShadeCountCase({
    name: "shade-edge-component-difference",
    rows: 1,
    columns: 5,
    definitionId: "clue-shade-edge-number-component-difference",
    kind: "edge-number",
    anchor: { kind: "edge", orientation: "vertical", row: 0, column: 2 },
    value: 1,
    black: ["0:0", "0:1"],
    white: ["0:2", "0:3", "0:4"],
  }), "unique"],
  [anchoredShadeCountCase({
    name: "shade-vertex-number-count",
    rows: 2,
    columns: 2,
    definitionId: "clue-shade-vertex-number-count",
    kind: "vertex-number",
    anchor: { kind: "vertex", row: 1, column: 1 },
    value: 2,
    black: ["0:0", "1:1"],
    white: ["0:1", "1:0"],
  }), "unique"],
  [anchoredShadeCountCase({
    name: "shade-land-measurement",
    rows: 4,
    columns: 4,
    definitionId: "clue-shade-vertex-number-land-measurement",
    kind: "vertex-number",
    anchor: { kind: "vertex", row: 2, column: 2 },
    value: 7,
    black: ["1:1", "0:1", "0:2", "0:3", "1:3", "2:3", "2:2"],
    white: ["0:0", "1:0", "1:2", "2:0", "2:1", "3:0", "3:1", "3:2", "3:3"],
  }), "unique"],
  [anchoredShadeCountCase({
    name: "shade-land-measurement-disconnected",
    rows: 3,
    columns: 3,
    definitionId: "clue-shade-vertex-number-land-measurement",
    kind: "vertex-number",
    anchor: { kind: "vertex", row: 1, column: 1 },
    value: 7,
    black: ["0:0", "1:1"],
    white: ["0:1", "0:2", "1:0", "1:2", "2:0", "2:1", "2:2"],
  }), "unsat"],
  [anchoredShadeCountCase({
    name: "shade-exterior-number-count-gap",
    rows: 1,
    columns: 3,
    definitionId: "clue-shade-exterior-number-count",
    kind: "exterior-number",
    anchor: { kind: "exterior", side: "left", index: 0 },
    value: 2,
    black: ["0:0", "0:2"],
    white: [],
    activeCells: ["0:0", "0:2"],
  }), "unique"],
  [anchoredShadeCountCase({
    name: "shade-exterior-segment-count",
    rows: 1,
    columns: 5,
    definitionId: "clue-shade-exterior-number-segments",
    kind: "exterior-number",
    anchor: { kind: "exterior", side: "left", index: 0 },
    value: 2,
    black: ["0:0", "0:2", "0:3"],
    white: ["0:1", "0:4"],
  }), "unique"],
  [anchoredShadeCountCase({
    name: "shade-exterior-longest-segment",
    rows: 1,
    columns: 5,
    definitionId: "clue-shade-exterior-number-longest-segment",
    kind: "exterior-number",
    anchor: { kind: "exterior", side: "left", index: 0 },
    value: 2,
    black: ["0:0", "0:2", "0:3"],
    white: ["0:1", "0:4"],
  }), "unique"],
  [anchoredShadeCountCase({
    name: "shade-exterior-first-segment-left",
    rows: 1,
    columns: 5,
    definitionId: "clue-shade-exterior-number-first-segment",
    kind: "exterior-number",
    anchor: { kind: "exterior", side: "left", index: 0 },
    value: 1,
    black: ["0:0", "0:2", "0:3"],
    white: ["0:1", "0:4"],
  }), "unique"],
  [anchoredShadeCountCase({
    name: "shade-exterior-first-segment-right",
    rows: 1,
    columns: 5,
    definitionId: "clue-shade-exterior-number-first-segment",
    kind: "exterior-number",
    anchor: { kind: "exterior", side: "right", index: 0 },
    value: 2,
    black: ["0:0", "0:2", "0:3"],
    white: ["0:1", "0:4"],
  }), "unique"],
  [anchoredShadeCountCase({
    name: "shade-exterior-segment-gap",
    rows: 1,
    columns: 3,
    definitionId: "clue-shade-exterior-number-segments",
    kind: "exterior-number",
    anchor: { kind: "exterior", side: "left", index: 0 },
    value: 2,
    black: ["0:0", "0:2"],
    white: [],
    activeCells: ["0:0", "0:2"],
  }), "unique"],
  [cellDotRuleCase({
    name: "shade-cell-dot-center-symmetry",
    rows: 3,
    columns: 3,
    definitionId: "clue-shade-cell-dot-center-symmetry-white",
    position: "1:1",
    white: ["1:0", "1:1", "1:2"],
  }), "unique"],
  [cellDotRuleCase({
    name: "shade-cell-dot-center-asymmetry",
    rows: 3,
    columns: 3,
    definitionId: "clue-shade-cell-dot-center-symmetry-white",
    position: "1:1",
    white: ["1:1", "1:2"],
  }), "unsat"],
  [cellDotRuleCase({
    name: "shade-cell-dot-axis-symmetry",
    rows: 3,
    columns: 3,
    definitionId: "clue-shade-cell-dot-axis-symmetry-white",
    position: "1:1",
    white: ["0:1", "1:0", "1:1", "1:2"],
  }), "unique"],
  [cellDotRuleCase({
    name: "shade-cell-dot-axis-asymmetry",
    rows: 5,
    columns: 5,
    definitionId: "clue-shade-cell-dot-axis-symmetry-white",
    position: "2:2",
    white: ["2:2", "1:2", "2:3", "2:4"],
  }), "unsat"],
  [cellDotRuleCase({
    name: "shade-cell-dot-one-white-neighbor",
    rows: 3,
    columns: 3,
    definitionId: "clue-shade-cell-dot-one-white-neighbor-white",
    position: "1:1",
    white: ["1:1", "1:0"],
  }), "unique"],
  [cellDotRuleCase({
    name: "shade-cell-dot-two-white-neighbors",
    rows: 3,
    columns: 3,
    definitionId: "clue-shade-cell-dot-one-white-neighbor-white",
    position: "1:1",
    white: ["1:1", "1:0", "1:2"],
  }), "unsat"],
  [anchoredDotRuleCase({
    name: "shade-edge-dot-both-white",
    rows: 1,
    columns: 2,
    definitionId: "clue-shade-edge-dot-both-white",
    kind: "edge-white-dot",
    anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 },
    white: ["0:0", "0:1"],
  }), "unique"],
  [anchoredDotRuleCase({
    name: "shade-edge-dot-one-black",
    rows: 1,
    columns: 2,
    definitionId: "clue-shade-edge-dot-one-black-white",
    kind: "edge-white-dot",
    anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 },
    white: ["0:0"],
  }), "unique"],
  [anchoredDotRuleCase({
    name: "shade-edge-dot-both-black",
    rows: 1,
    columns: 2,
    definitionId: "clue-shade-edge-dot-both-black",
    kind: "edge-black-dot",
    anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 },
    white: [],
  }), "unique"],
  [anchoredDotRuleCase({
    name: "shade-edge-dot-congruent-components",
    rows: 1,
    columns: 4,
    definitionId: "clue-shade-edge-dot-congruent-components-white",
    kind: "edge-white-dot",
    anchor: { kind: "edge", orientation: "vertical", row: 0, column: 2 },
    white: ["0:2", "0:3"],
  }), "unique"],
  [anchoredDotRuleCase({
    name: "shade-edge-dot-noncongruent-components",
    rows: 1,
    columns: 5,
    definitionId: "clue-shade-edge-dot-congruent-components-white",
    kind: "edge-white-dot",
    anchor: { kind: "edge", orientation: "vertical", row: 0, column: 2 },
    white: ["0:2", "0:3", "0:4"],
  }), "unsat"],
  [anchoredDotRuleCase({
    name: "shade-edge-dot-mirrored-components",
    rows: 1,
    columns: 4,
    definitionId: "clue-shade-edge-dot-mirrored-components-black",
    kind: "edge-black-dot",
    anchor: { kind: "edge", orientation: "vertical", row: 0, column: 2 },
    white: ["0:2", "0:3"],
  }), "unique"],
  [anchoredDotRuleCase({
    name: "shade-vertex-dot-more-black",
    rows: 2,
    columns: 2,
    definitionId: "clue-shade-vertex-dot-more-black",
    kind: "vertex-black-dot",
    anchor: { kind: "vertex", row: 1, column: 1 },
    white: ["0:0"],
  }), "unique"],
  [anchoredDotRuleCase({
    name: "shade-vertex-dot-more-white",
    rows: 2,
    columns: 2,
    definitionId: "clue-shade-vertex-dot-more-white",
    kind: "vertex-white-dot",
    anchor: { kind: "vertex", row: 1, column: 1 },
    white: ["0:0", "0:1", "1:0"],
  }), "unique"],
  [anchoredDotRuleCase({
    name: "shade-vertex-dot-checkerboard",
    rows: 2,
    columns: 2,
    definitionId: "clue-shade-vertex-dot-checkerboard-white",
    kind: "vertex-white-dot",
    anchor: { kind: "vertex", row: 1, column: 1 },
    white: ["0:1", "1:0"],
  }), "unique"],
  [anchoredDotRuleCase({
    name: "shade-vertex-dot-noncheckerboard",
    rows: 2,
    columns: 2,
    definitionId: "clue-shade-vertex-dot-checkerboard-white",
    kind: "vertex-white-dot",
    anchor: { kind: "vertex", row: 1, column: 1 },
    white: ["1:0", "1:1"],
  }), "unsat"],
  [koburinNumber(2), "unique"],
  [board({ name: "loop-visit-all-2x2", rows: 2, columns: 2, globalId: "rule-loop-visit-all-unclued" }), "unique"],
  [board({ name: "loop-visit-all-3x3", rows: 3, columns: 3, globalId: "rule-loop-visit-all-unclued" }), "unsat"],
  [loopCellNumberRule("loop-eight-visited", "clue-loop-cell-number-eight-visited", 8), "unique"],
  [loopCellNumberRule("loop-eight-turns", "clue-loop-cell-number-eight-turns", 4), "unique"],
  [loopCellNumberRule("loop-eight-unvisited", "clue-loop-cell-number-eight-unvisited", 0), "unique"],
  [loopCellNumberRule("loop-four-turns", "clue-loop-cell-number-four-turns", 0), "unique"],
  [loopCellNumberRule("loop-four-visited", "clue-loop-cell-number-four-visited", 4), "unique"],
  [loopAnchoredRule({
    name: "loop-grandstands-outward-segment",
    rows: 4,
    columns: 5,
    definitionId: "clue-loop-cell-number-grandstands",
    kind: "cell-number",
    anchor: { kind: "cell", cell: "1:0" },
    value: 3,
    activeCells: ["1:0", "1:1", "1:2", "1:3", "1:4", "2:1", "2:4", "3:1", "3:2", "3:3", "3:4"],
    globalId: "rule-loop-visit-all-unclued",
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-balance-number-sum",
    rows: 2,
    columns: 3,
    definitionId: "clue-loop-cell-number-balance-arms",
    kind: "cell-number",
    anchor: { kind: "cell", cell: "0:1" },
    value: 2,
    globalId: "rule-loop-visit-all-unclued",
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-balance-number-wrong-sum",
    rows: 2,
    columns: 3,
    definitionId: "clue-loop-cell-number-balance-arms",
    kind: "cell-number",
    anchor: { kind: "cell", cell: "0:1" },
    value: 3,
    globalId: "rule-loop-visit-all-unclued",
  }), "unsat"],
  [loopAnchoredRule({
    name: "loop-edge-segment-length",
    rows: 2,
    columns: 4,
    definitionId: "clue-loop-edge-number-segment-length",
    kind: "edge-number",
    anchor: { kind: "edge", orientation: "vertical", row: 0, column: 2 },
    value: 3,
    globalId: "rule-loop-visit-all-unclued",
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-edge-outward-length-sum",
    rows: 2,
    columns: 3,
    definitionId: "clue-loop-edge-number-outward-length-sum",
    kind: "edge-number",
    anchor: { kind: "edge", orientation: "horizontal", row: 1, column: 1 },
    value: 0,
    globalId: "rule-loop-visit-all-unclued",
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-edge-visited-count",
    rows: 2,
    columns: 2,
    definitionId: "clue-loop-edge-number-visited-cells",
    kind: "edge-number",
    anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 },
    value: 2,
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-vertex-visited-count",
    rows: 2,
    columns: 2,
    definitionId: "clue-loop-vertex-number-visited-cells",
    kind: "vertex-number",
    anchor: { kind: "vertex", row: 1, column: 1 },
    value: 4,
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-vertex-edge-count",
    rows: 2,
    columns: 2,
    definitionId: "clue-loop-vertex-number-edge-count",
    kind: "vertex-number",
    anchor: { kind: "vertex", row: 1, column: 1 },
    value: 4,
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-vertex-turn-count",
    rows: 2,
    columns: 2,
    definitionId: "clue-loop-vertex-number-turn-count",
    kind: "vertex-number",
    anchor: { kind: "vertex", row: 1, column: 1 },
    value: 4,
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-cell-inside-vertices",
    rows: 2,
    columns: 2,
    definitionId: "clue-loop-cell-number-inside-vertices",
    kind: "cell-number",
    anchor: { kind: "cell", cell: "0:0" },
    value: 1,
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-cell-dot-visited",
    rows: 2,
    columns: 2,
    definitionId: "clue-loop-cell-dot-visited-white",
    kind: "white-dot",
    anchor: { kind: "cell", cell: "0:0" },
    value: 0,
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-cell-dot-unvisited",
    rows: 2,
    columns: 2,
    definitionId: "clue-loop-cell-dot-unvisited-black",
    kind: "black-dot",
    anchor: { kind: "cell", cell: "0:0" },
    value: 0,
  }), "unsat"],
  [loopAnchoredRule({
    name: "loop-unvisited-center-symmetry",
    rows: 3,
    columns: 3,
    definitionId: "clue-loop-cell-dot-unvisited-center-symmetry-white",
    kind: "white-dot",
    anchor: { kind: "cell", cell: "1:1" },
    value: 0,
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-unvisited-axis-symmetry",
    rows: 3,
    columns: 3,
    definitionId: "clue-loop-cell-dot-unvisited-axis-symmetry-black",
    kind: "black-dot",
    anchor: { kind: "cell", cell: "1:1" },
    value: 0,
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-cell-dot-generic-turn",
    rows: 2,
    columns: 2,
    definitionId: "clue-loop-cell-dot-turn-white",
    kind: "white-dot",
    anchor: { kind: "cell", cell: "0:0" },
    value: 0,
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-cell-dot-generic-straight",
    rows: 2,
    columns: 2,
    definitionId: "clue-loop-cell-dot-straight-black",
    kind: "black-dot",
    anchor: { kind: "cell", cell: "0:0" },
    value: 0,
  }), "unsat"],
  [loopAnchoredRule({
    name: "loop-cell-dot-equal-arms",
    rows: 2,
    columns: 3,
    definitionId: "clue-loop-cell-dot-equal-arms-white",
    kind: "white-dot",
    anchor: { kind: "cell", cell: "0:1" },
    value: 0,
    globalId: "rule-loop-visit-all-unclued",
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-cell-dot-unequal-arms",
    rows: 2,
    columns: 4,
    definitionId: "clue-loop-cell-dot-unequal-arms-black",
    kind: "black-dot",
    anchor: { kind: "cell", cell: "0:1" },
    value: 0,
    globalId: "rule-loop-visit-all-unclued",
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-cell-dot-arm-difference-one",
    rows: 2,
    columns: 4,
    definitionId: "clue-loop-cell-dot-arm-difference-one-white",
    kind: "white-dot",
    anchor: { kind: "cell", cell: "0:1" },
    value: 0,
    globalId: "rule-loop-visit-all-unclued",
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-masyu-white",
    rows: 2,
    columns: 3,
    definitionId: "clue-loop-cell-dot-masyu-white",
    kind: "white-dot",
    anchor: { kind: "cell", cell: "0:1" },
    value: 0,
    globalId: "rule-loop-visit-all-unclued",
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-masyu-black-invalid",
    rows: 2,
    columns: 2,
    definitionId: "clue-loop-cell-dot-masyu-black",
    kind: "black-dot",
    anchor: { kind: "cell", cell: "0:0" },
    value: 0,
  }), "unsat"],
  [loopAnchoredRule({
    name: "loop-pearl-black",
    rows: 2,
    columns: 2,
    definitionId: "clue-loop-cell-dot-pearl-black",
    kind: "black-dot",
    anchor: { kind: "cell", cell: "0:0" },
    value: 0,
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-pearl-white-invalid",
    rows: 2,
    columns: 2,
    definitionId: "clue-loop-cell-dot-pearl-white",
    kind: "white-dot",
    anchor: { kind: "cell", cell: "0:0" },
    value: 0,
  }), "unsat"],
  [loopAnchoredRule({
    name: "loop-edge-dot-one-visited",
    rows: 2,
    columns: 3,
    definitionId: "clue-loop-edge-dot-one-visited-black",
    kind: "edge-black-dot",
    anchor: { kind: "edge", orientation: "vertical", row: 0, column: 2 },
    value: 0,
    activeCells: ["0:0", "0:1", "0:2", "1:0", "1:1"],
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-edge-dot-traversed",
    rows: 2,
    columns: 2,
    definitionId: "clue-loop-edge-dot-through-white",
    kind: "edge-white-dot",
    anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 },
    value: 0,
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-edge-dot-not-traversed",
    rows: 2,
    columns: 2,
    definitionId: "clue-loop-edge-dot-not-through-black",
    kind: "edge-black-dot",
    anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 },
    value: 0,
  }), "unsat"],
  [loopAnchoredRule({
    name: "loop-edge-dot-midpoint",
    rows: 2,
    columns: 4,
    definitionId: "clue-loop-edge-dot-midpoint-white",
    kind: "edge-white-dot",
    anchor: { kind: "edge", orientation: "vertical", row: 0, column: 2 },
    value: 0,
    globalId: "rule-loop-visit-all-unclued",
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-edge-dot-split-difference-one",
    rows: 2,
    columns: 5,
    definitionId: "clue-loop-edge-dot-split-difference-one-white",
    kind: "edge-white-dot",
    anchor: { kind: "edge", orientation: "vertical", row: 0, column: 2 },
    value: 0,
    globalId: "rule-loop-visit-all-unclued",
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-edge-dot-split-ratio-two",
    rows: 2,
    columns: 3,
    definitionId: "clue-loop-edge-dot-split-ratio-two-black",
    kind: "edge-black-dot",
    anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 },
    value: 0,
    globalId: "rule-loop-visit-all-unclued",
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-edge-dot-same-orientation",
    rows: 2,
    columns: 2,
    definitionId: "clue-loop-edge-dot-same-cell-type-white",
    kind: "edge-white-dot",
    anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 },
    value: 0,
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-edge-dot-opposite-orientation",
    rows: 2,
    columns: 2,
    definitionId: "clue-loop-edge-dot-opposite-cell-type-black",
    kind: "edge-black-dot",
    anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 },
    value: 0,
  }), "unsat"],
  [loopAnchoredRule({
    name: "loop-vertex-dot-more-visited",
    rows: 2,
    columns: 2,
    definitionId: "clue-loop-vertex-dot-more-visited-white",
    kind: "vertex-white-dot",
    anchor: { kind: "vertex", row: 1, column: 1 },
    value: 0,
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-vertex-dot-more-unvisited",
    rows: 2,
    columns: 2,
    definitionId: "clue-loop-vertex-dot-more-unvisited-black",
    kind: "vertex-black-dot",
    anchor: { kind: "vertex", row: 1, column: 1 },
    value: 0,
  }), "unsat"],
  [loopAnchoredRule({
    name: "loop-vertex-dot-inside",
    rows: 2,
    columns: 2,
    definitionId: "clue-loop-vertex-dot-inside-white",
    kind: "vertex-white-dot",
    anchor: { kind: "vertex", row: 1, column: 1 },
    value: 0,
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-vertex-dot-outside",
    rows: 2,
    columns: 2,
    definitionId: "clue-loop-vertex-dot-outside-black",
    kind: "vertex-black-dot",
    anchor: { kind: "vertex", row: 1, column: 1 },
    value: 0,
  }), "unsat"],
  [loopAnchoredRule({
    name: "loop-exterior-visited-count",
    rows: 2,
    columns: 2,
    definitionId: "clue-loop-exterior-number-visited-cells",
    kind: "exterior-number",
    anchor: { kind: "exterior", side: "left", index: 0 },
    value: 2,
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-exterior-segment-count",
    rows: 2,
    columns: 3,
    definitionId: "clue-loop-exterior-number-segment-count",
    kind: "exterior-number",
    anchor: { kind: "exterior", side: "left", index: 0 },
    value: 1,
    globalId: "rule-loop-visit-all-unclued",
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-exterior-longest-segment",
    rows: 2,
    columns: 3,
    definitionId: "clue-loop-exterior-number-longest-segment",
    kind: "exterior-number",
    anchor: { kind: "exterior", side: "left", index: 0 },
    value: 2,
    globalId: "rule-loop-visit-all-unclued",
  }), "unique"],
  [loopAnchoredRule({
    name: "loop-exterior-shortest-segment",
    rows: 2,
    columns: 3,
    definitionId: "clue-loop-exterior-number-shortest-segment",
    kind: "exterior-number",
    anchor: { kind: "exterior", side: "left", index: 0 },
    value: 2,
    globalId: "rule-loop-visit-all-unclued",
  }), "unique"],
  [board({
    name: "irregular-cycle",
    rows: 2,
    columns: 3,
    globalId: "rule-single-loop",
    activeCells: ["0:0", "0:1", "1:0", "1:1", "0:2"],
  }), "unique"],
  [board({
    name: "irregular-no-cycle",
    rows: 2,
    columns: 2,
    globalId: "rule-single-loop",
    activeCells: ["0:0", "0:1", "1:0"],
  }), "unsat"],
  [constrainedShade({
    name: "white-connectivity-gap",
    rows: 1,
    columns: 3,
    globalId: "rule-shade-white-connected",
    white: ["0:0", "0:2"],
    activeCells: ["0:0", "0:2"],
  }), "unsat"],
  [constrainedShade({
    name: "no-black-2x2",
    rows: 2,
    columns: 2,
    globalId: "rule-shade-no-black-2x2",
    black: cells(2, 2),
  }), "unsat"],
  [constrainedShade({
    name: "incomplete-black-2x2",
    rows: 2,
    columns: 2,
    globalId: "rule-shade-no-black-2x2",
    black: ["0:0", "0:1", "1:0"],
    activeCells: ["0:0", "0:1", "1:0"],
  }), "unique"],
  [constrainedShade({
    name: "no-white-2x2",
    rows: 2,
    columns: 2,
    globalId: "rule-shade-no-white-2x2",
    white: cells(2, 2),
  }), "unsat"],
  [constrainedShade({
    name: "no-run-three",
    rows: 1,
    columns: 3,
    globalId: "rule-shade-no-three",
    black: cells(1, 3),
  }), "unsat"],
  [constrainedShade({
    name: "run-gap-breaks-adjacency",
    rows: 1,
    columns: 4,
    globalId: "rule-shade-no-three",
    black: ["0:0", "0:2", "0:3"],
    activeCells: ["0:0", "0:2", "0:3"],
  }), "unique"],
  [constrainedShade({
    name: "no-run-four",
    rows: 1,
    columns: 4,
    globalId: "rule-shade-no-four",
    black: cells(1, 4),
  }), "unsat"],
  [constrainedShade({
    name: "equal-line-counts",
    rows: 2,
    columns: 2,
    globalId: "rule-shade-equal-lines",
    black: ["0:0"],
    white: ["0:1", "1:0", "1:1"],
  }), "unsat"],
  [constrainedShade({
    name: "black-diagonal-contact",
    rows: 2,
    columns: 2,
    globalId: "rule-shade-black-no-touch",
    black: ["0:0", "1:1"],
  }), "unsat"],
  [constrainedShade({
    name: "snake-minimum-length",
    rows: 1,
    columns: 1,
    globalId: "rule-shade-snake",
    black: ["0:0"],
  }), "unsat"],
  [constrainedShade({
    name: "snake-two-cells",
    rows: 1,
    columns: 2,
    globalId: "rule-shade-snake",
    black: ["0:0", "0:1"],
  }), "unique"],
  [constrainedShade({
    name: "snake-diagonal-self-contact",
    rows: 2,
    columns: 2,
    globalId: "rule-shade-snake",
    black: ["0:0", "1:1"],
  }), "unsat"],
  [constrainedShade({
    name: "snake-branch",
    rows: 2,
    columns: 3,
    globalId: "rule-shade-snake",
    black: ["0:0", "0:1", "0:2", "1:1"],
    white: ["1:0", "1:2"],
  }), "unsat"],
];

for (const [puzzle, expected] of cases) {
  const result = evaluateBoard(puzzle);
  if (result.status !== expected) {
    throw new Error(`${puzzle.name}: expected ${expected}, received ${result.status} (${result.detail})`);
  }
  if (expected === "unique" && result.solutions?.length !== 1) throw new Error(`${puzzle.name}: unique result must carry one solution layer`);
  if (expected === "multiple" && (result.solutions?.length !== 2 || JSON.stringify(result.solutions[0]) === JSON.stringify(result.solutions[1]))) throw new Error(`${puzzle.name}: multiple result must carry two distinct layers`);
  if (expected === "unsat" && result.solutions?.length !== 0) throw new Error(`${puzzle.name}: unsat result must not carry a solution`);
  if (expected === "unique") {
    const layer = result.solutions[0];
    const expectedLayer = puzzle.mechanic === "shade" ? "shading" : puzzle.mechanic === "number" ? "numbers" : puzzle.mechanic === "region" ? "regions" : "loop";
    if (!layer?.[expectedLayer]) throw new Error(`${puzzle.name}: missing ${expectedLayer} payload`);
    if (puzzle.mechanic === "loop") {
      const edges = new Set(puzzle.activeCells);
      const loop = layer.loop ?? [];
      if (!loop.length || loop.some((segment) => !edges.has(segment.from) || !edges.has(segment.to) || Math.abs(Number(segment.from.split(":")[0]) - Number(segment.to.split(":")[0])) + Math.abs(Number(segment.from.split(":")[1]) - Number(segment.to.split(":")[1])) !== 1)) throw new Error(`${puzzle.name}: loop payload contains a non-adjacent segment`);
      const degree = new Map();
      for (const segment of loop) { degree.set(segment.from, (degree.get(segment.from) ?? 0) + 1); degree.set(segment.to, (degree.get(segment.to) ?? 0) + 1); }
      if ([...degree.values()].some((value) => value !== 2)) throw new Error(`${puzzle.name}: loop payload is not a closed degree-two cycle`);
    }
  }
  console.log(`${puzzle.name}: ${result.status} (${result.solverStats?.exploredNodes ?? 0} nodes)`);
}

console.log(`Solver smoke checks passed: ${cases.length}/${cases.length}`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function checkRegionFixture({ name, labels, globalId = "rule-regions-connected", targets = [] }) {
  const rows = labels.length;
  const columns = labels[0].length;
  const puzzle = board({
    name,
    rows,
    columns,
    globalId,
    mechanic: "region",
    clueCards: targets.map((target, index) => ({ instanceId: `${name}-card-${index}`, definitionId: target.definitionId, placedClueId: `${name}-clue-${index}` })),
    clues: targets.map((target, index) => ({ id: `${name}-clue-${index}`, kind: target.kind, anchor: target.anchor, value: target.value ?? 0, sourceCardInstanceId: `${name}-card-${index}` })),
  });
  const compiled = compileBoard(puzzle);
  assert(!("status" in compiled), `${name}: region fixture did not compile (${"detail" in compiled ? compiled.detail : "unknown"})`);
  const assignment = new Map();
  for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) assignment.set(`${row}:${column}`, labels[row][column]);
  assert(validateRegionPartition(compiled, assignment), `${name}: explicit region partition was rejected`);
}

const regionFixtures = [
  { name: "region-global-rectangles", globalId: "rule-region-rectangles", labels: [[0, 0], [1, 1]] },
  { name: "region-global-center-symmetric", globalId: "rule-region-center-symmetric", labels: [[0, 0], [1, 1]] },
  { name: "region-global-one-clue", globalId: "rule-region-one-cell-clue", labels: [[0, 0], [1, 1]], targets: [
    { definitionId: "clue-region-cell-area", kind: "cell-number", anchor: { kind: "cell", cell: "0:0" }, value: 2 },
    { definitionId: "clue-region-cell-area", kind: "cell-number", anchor: { kind: "cell", cell: "1:0" }, value: 2 },
  ] },
  { name: "region-global-distinct-shapes", globalId: "rule-region-all-shapes-distinct", labels: [[0, 1], [1, 1]] },
  { name: "region-cell-area", labels: [[0, 0], [0, 0]], targets: [{ definitionId: "clue-region-cell-area", kind: "cell-number", anchor: { kind: "cell", cell: "0:0" }, value: 4 }] },
  { name: "region-cell-boundary-count", labels: [[0, 0], [0, 0]], targets: [{ definitionId: "clue-region-cell-boundary-count", kind: "cell-number", anchor: { kind: "cell", cell: "0:0" }, value: 2 }] },
  { name: "region-cell-neighbor-count", labels: [[0, 0], [1, 1]], targets: [{ definitionId: "clue-region-cell-neighbor-count", kind: "cell-number", anchor: { kind: "cell", cell: "0:0" }, value: 1 }] },
  { name: "region-cell-perimeter", labels: [[0, 0], [0, 0]], targets: [{ definitionId: "clue-region-cell-perimeter", kind: "cell-number", anchor: { kind: "cell", cell: "0:0" }, value: 8 }] },
  { name: "region-edge-area-sum", labels: [[0, 0], [1, 1]], targets: [{ definitionId: "clue-region-edge-area-sum", kind: "edge-number", anchor: { kind: "edge", orientation: "horizontal", row: 1, column: 0 }, value: 4 }] },
  { name: "region-edge-area-difference", labels: [[0, 0], [1, 1]], targets: [{ definitionId: "clue-region-edge-area-difference", kind: "edge-number", anchor: { kind: "edge", orientation: "horizontal", row: 1, column: 0 }, value: 0 }] },
  { name: "region-edge-boundary-length", labels: [[0, 0], [1, 1]], targets: [{ definitionId: "clue-region-edge-boundary-length", kind: "edge-number", anchor: { kind: "edge", orientation: "horizontal", row: 1, column: 0 }, value: 2 }] },
  { name: "region-vertex-region-count", labels: [[0, 1], [2, 3]], targets: [{ definitionId: "clue-region-vertex-region-count", kind: "vertex-number", anchor: { kind: "vertex", row: 1, column: 1 }, value: 4 }] },
  { name: "region-vertex-area-sum", labels: [[0, 1], [2, 3]], targets: [{ definitionId: "clue-region-vertex-area-sum", kind: "vertex-number", anchor: { kind: "vertex", row: 1, column: 1 }, value: 4 }] },
  { name: "region-vertex-shape-count", labels: [[0, 0], [1, 2]], targets: [{ definitionId: "clue-region-vertex-shape-count", kind: "vertex-number", anchor: { kind: "vertex", row: 1, column: 1 }, value: 2 }] },
  { name: "region-cell-dot-neighborhood", labels: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], targets: [{ definitionId: "clue-region-cell-dot-neighborhood-white", kind: "white-dot", anchor: { kind: "cell", cell: "1:1" } }] },
  { name: "region-cell-dot-center", labels: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], targets: [{ definitionId: "clue-region-cell-dot-center-white", kind: "white-dot", anchor: { kind: "cell", cell: "1:1" } }] },
  { name: "region-cell-dot-axis", labels: [[0, 0, 0]], targets: [{ definitionId: "clue-region-cell-dot-axis-black", kind: "black-dot", anchor: { kind: "cell", cell: "0:1" } }] },
  { name: "region-cell-dot-rotated-shape", labels: [[0, 1, 1], [0, 0, 1]], targets: [
    { definitionId: "clue-region-cell-dot-rotated-shape-white", kind: "white-dot", anchor: { kind: "cell", cell: "0:0" } },
    { definitionId: "clue-region-cell-dot-rotated-shape-white", kind: "white-dot", anchor: { kind: "cell", cell: "0:1" } },
  ] },
  { name: "region-cell-dot-translated-shape", labels: [[0, 0, 1, 1], [0, 0, 1, 1]], targets: [
    { definitionId: "clue-region-cell-dot-translated-shape-black", kind: "black-dot", anchor: { kind: "cell", cell: "0:0" } },
    { definitionId: "clue-region-cell-dot-translated-shape-black", kind: "black-dot", anchor: { kind: "cell", cell: "0:2" } },
  ] },
  { name: "region-edge-dot-boundary", labels: [[0, 0], [1, 1]], targets: [{ definitionId: "clue-region-edge-dot-boundary-white", kind: "edge-white-dot", anchor: { kind: "edge", orientation: "horizontal", row: 1, column: 0 } }] },
  { name: "region-edge-dot-congruent", labels: [[0, 0], [1, 1]], targets: [{ definitionId: "clue-region-edge-dot-congruent-black", kind: "edge-black-dot", anchor: { kind: "edge", orientation: "horizontal", row: 1, column: 0 } }] },
  { name: "region-edge-dot-mirror", labels: [[0, 0], [1, 1]], targets: [{ definitionId: "clue-region-edge-dot-mirror-white", kind: "edge-white-dot", anchor: { kind: "edge", orientation: "horizontal", row: 1, column: 0 } }] },
  { name: "region-edge-dot-center", labels: [[0, 0]], targets: [{ definitionId: "clue-region-edge-dot-center-white", kind: "edge-white-dot", anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 } }] },
  { name: "region-edge-dot-axis", labels: [[0, 0]], targets: [{ definitionId: "clue-region-edge-dot-axis-black", kind: "edge-black-dot", anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 } }] },
  { name: "region-vertex-dot-three-lines", labels: [[0, 1], [2, 1]], targets: [{ definitionId: "clue-region-vertex-dot-three-lines-white", kind: "vertex-white-dot", anchor: { kind: "vertex", row: 1, column: 1 } }] },
  { name: "region-vertex-dot-four-lines", labels: [[0, 1], [2, 3]], targets: [{ definitionId: "clue-region-vertex-dot-four-lines-black", kind: "vertex-black-dot", anchor: { kind: "vertex", row: 1, column: 1 } }] },
  { name: "region-vertex-dot-zero-lines", labels: [[0, 0], [0, 0]], targets: [{ definitionId: "clue-region-vertex-dot-zero-lines-white", kind: "vertex-white-dot", anchor: { kind: "vertex", row: 1, column: 1 } }] },
  { name: "region-vertex-dot-center", labels: [[0, 0], [0, 0]], targets: [{ definitionId: "clue-region-vertex-dot-center-black", kind: "vertex-black-dot", anchor: { kind: "vertex", row: 1, column: 1 } }] },
  { name: "region-vertex-dot-axis", labels: [[0, 0], [0, 0]], targets: [{ definitionId: "clue-region-vertex-dot-axis-white", kind: "vertex-white-dot", anchor: { kind: "vertex", row: 1, column: 1 } }] },
  { name: "region-exterior-count", labels: [[0, 0, 1]], targets: [{ definitionId: "clue-region-exterior-count", kind: "exterior-number", anchor: { kind: "exterior", side: "left", index: 0 }, value: 2 }] },
  { name: "region-exterior-longest", labels: [[0, 0, 1]], targets: [{ definitionId: "clue-region-exterior-longest-run", kind: "exterior-number", anchor: { kind: "exterior", side: "left", index: 0 }, value: 2 }] },
  { name: "region-exterior-shortest", labels: [[0, 0, 1]], targets: [{ definitionId: "clue-region-exterior-shortest-run", kind: "exterior-number", anchor: { kind: "exterior", side: "left", index: 0 }, value: 1 }] },
];

for (const fixture of regionFixtures) checkRegionFixture(fixture);
console.log(`Region constraint checks passed: ${regionFixtures.length}/${regionFixtures.length}`);

const geometry = {
  rows: 3,
  columns: 4,
  activeCells: ["0:0", "0:1", "0:2", "0:3", "1:0", "1:2", "1:3", "2:0", "2:1", "2:2", "2:3"],
};
const placedClue = (id, anchor) => ({ id, clueKind: "cell-number", anchor });

assert(!canRemoveCell({
  geometry,
  clues: [placedClue("edge", { kind: "edge", orientation: "vertical", row: 0, column: 1 })],
}, "0:0"), "A cell touching an internal edge clue must be protected");
assert(!canRemoveCell({
  geometry,
  clues: [placedClue("vertex", { kind: "vertex", row: 1, column: 1 })],
}, "0:0"), "A cell touching an internal vertex clue must be protected");
assert(canRemoveCell({
  geometry,
  clues: [placedClue("cell", { kind: "cell", cell: "0:0" })],
}, "0:0"), "A cell clue should be removed together with its cell");
assert(canRemoveCell({
  geometry,
  clues: [placedClue("outside", { kind: "exterior", side: "left", index: 0 })],
}, "0:0"), "Exterior clues must not protect individual cells");

const rowObserved = cellsObservedByExterior(geometry, { kind: "exterior", side: "left", index: 1 });
assert(rowObserved.join("|") === "1:0|1:2|1:3", "Exterior row clues must observe across removed-cell gaps");
const columnObserved = cellsObservedByExterior(geometry, { kind: "exterior", side: "top", index: 1 });
assert(columnObserved.join("|") === "0:1|2:1", "Exterior column clues must observe across removed-cell gaps");

const legacyCellAnchor = clueAnchorOf({ cellId: "2:3" });
assert(legacyCellAnchor?.kind === "cell" && legacyCellAnchor.cell === "2:3", "Legacy cellId must normalize to a cell anchor");
const legacyEdgeAnchor = clueAnchorOf({ edgeId: "vertical:1:2" });
assert(
  legacyEdgeAnchor?.kind === "edge" && legacyEdgeAnchor.orientation === "vertical" && legacyEdgeAnchor.row === 1 && legacyEdgeAnchor.column === 2,
  "Legacy edgeId must normalize to an edge anchor",
);

console.log("Anchor and irregular-topology checks passed: 8/8");

const coverage = auditSolverCoverage();
assert(coverage.invalid.length === 0, `Solver coverage contains invalid entries: ${JSON.stringify(coverage.invalid)}`);
assert(coverage.counts.shade.implemented === coverage.counts.shade.total, `Shade coverage is incomplete: ${JSON.stringify(coverage.counts.shade)}`);
assert(coverage.counts.loop.implemented === coverage.counts.loop.total, `Loop coverage is incomplete: ${JSON.stringify(coverage.counts.loop)}`);
assert(coverage.counts.number.implemented === coverage.counts.number.total, `Number coverage is incomplete: ${JSON.stringify(coverage.counts.number)}`);
assert(coverage.counts.region.implemented === coverage.counts.region.total, `Region coverage is incomplete: ${JSON.stringify(coverage.counts.region)}`);
assert(coverage.implemented === coverage.total, `Ruleset coverage is incomplete: ${coverage.implemented}/${coverage.total}`);
console.log(`Ruleset solver coverage: ${coverage.implemented}/${coverage.total} (shade ${coverage.counts.shade.implemented}/${coverage.counts.shade.total}, loop ${coverage.counts.loop.implemented}/${coverage.counts.loop.total}, number ${coverage.counts.number.implemented}/${coverage.counts.number.total}, region ${coverage.counts.region.implemented}/${coverage.counts.region.total})`);

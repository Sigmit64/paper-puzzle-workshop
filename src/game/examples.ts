import { rectangularCells } from "./geometry";
import type { CellId } from "./types";
import { cellsTouchedByAnchor, type ClueAnchor, type PlacedClue, type PuzzleSolutionLayers, type RuleExample } from "./puzzle-model";
import type { RuleEntry, RuleFamily } from "./ruleset";

const cell = (row: number, column: number) => `${row}:${column}` as CellId;
const edge = (orientation: "horizontal" | "vertical", row: number, column: number): ClueAnchor => ({ kind: "edge", orientation, row, column });

function shadeRecord(blackCells: CellId[], rows = 4, columns = 4) {
  const black = new Set(blackCells);
  return Object.fromEntries(rectangularCells(rows, columns).map((id) => [id, black.has(id) ? "black" : "white"])) as Record<CellId, "black" | "white">;
}

const CHECKER = [cell(0, 0), cell(0, 2), cell(1, 1), cell(1, 3), cell(2, 0), cell(2, 2), cell(3, 1), cell(3, 3)];
const CONNECTED = [cell(0, 0), cell(0, 1), cell(1, 1), cell(2, 1), cell(2, 2), cell(3, 2)];
const SPARSE = [cell(0, 0), cell(0, 3), cell(3, 0), cell(3, 3)];
const STRAIGHT_SNAKE = [cell(0, 2), cell(1, 2), cell(2, 2), cell(3, 2)];

const LATIN: Partial<Record<CellId, number>> = Object.fromEntries(
  rectangularCells(4, 4).map((id) => {
    const [row, column] = id.split(":").map(Number);
    return [id, ((row + column) % 4) + 1];
  }),
);

const LATIN_THREE: Partial<Record<CellId, number>> = Object.fromEntries(
  rectangularCells(4, 4).flatMap((id) => {
    const [row, column] = id.split(":").map(Number);
    return row === column ? [] : [[id, ((column - row + 4) % 4) || 3]];
  }),
);

const LOOP_PERIMETER = [
  [cell(0, 0), cell(0, 1)], [cell(0, 1), cell(0, 2)], [cell(0, 2), cell(0, 3)],
  [cell(0, 3), cell(1, 3)], [cell(1, 3), cell(2, 3)], [cell(2, 3), cell(3, 3)],
  [cell(3, 3), cell(3, 2)], [cell(3, 2), cell(3, 1)], [cell(3, 1), cell(3, 0)],
  [cell(3, 0), cell(2, 0)], [cell(2, 0), cell(1, 0)], [cell(1, 0), cell(0, 0)],
].map(([from, to]) => ({ from, to }));

const LOOP_INNER = [
  [cell(0, 1), cell(0, 2)], [cell(0, 2), cell(1, 2)], [cell(1, 2), cell(2, 2)],
  [cell(2, 2), cell(3, 2)], [cell(3, 2), cell(3, 1)], [cell(3, 1), cell(2, 1)],
  [cell(2, 1), cell(1, 1)], [cell(1, 1), cell(0, 1)],
].map(([from, to]) => ({ from, to }));

const LOOP_ALL_CELLS = [
  [cell(0, 0), cell(0, 1)], [cell(0, 1), cell(0, 2)], [cell(0, 2), cell(0, 3)],
  [cell(0, 3), cell(1, 3)], [cell(1, 3), cell(2, 3)], [cell(2, 3), cell(3, 3)],
  [cell(3, 3), cell(3, 2)], [cell(3, 2), cell(2, 2)], [cell(2, 2), cell(1, 2)],
  [cell(1, 2), cell(1, 1)], [cell(1, 1), cell(2, 1)], [cell(2, 1), cell(3, 1)],
  [cell(3, 1), cell(3, 0)], [cell(3, 0), cell(2, 0)], [cell(2, 0), cell(1, 0)],
  [cell(1, 0), cell(0, 0)],
].map(([from, to]) => ({ from, to }));

const LOOP_CENTER_TURN = [
  [cell(1, 1), cell(1, 2)], [cell(1, 2), cell(2, 2)],
  [cell(2, 2), cell(2, 1)], [cell(2, 1), cell(1, 1)],
].map(([from, to]) => ({ from, to }));

const LOOP_AROUND_CENTER = [
  [cell(0, 0), cell(0, 1)], [cell(0, 1), cell(0, 2)], [cell(0, 2), cell(1, 2)],
  [cell(1, 2), cell(2, 2)], [cell(2, 2), cell(2, 1)], [cell(2, 1), cell(2, 0)],
  [cell(2, 0), cell(1, 0)], [cell(1, 0), cell(0, 0)],
].map(([from, to]) => ({ from, to }));

const LOOP_BALANCED = [
  [cell(1, 0), cell(1, 1)], [cell(1, 1), cell(1, 2)], [cell(1, 2), cell(2, 2)],
  [cell(2, 2), cell(2, 1)], [cell(2, 1), cell(2, 0)], [cell(2, 0), cell(1, 0)],
].map(([from, to]) => ({ from, to }));

const LOOP_CENTER_CORNER_LONG = [
  [cell(1, 1), cell(1, 2)], [cell(1, 2), cell(1, 3)], [cell(1, 3), cell(2, 3)],
  [cell(2, 3), cell(3, 3)], [cell(3, 3), cell(3, 2)], [cell(3, 2), cell(3, 1)],
  [cell(3, 1), cell(2, 1)], [cell(2, 1), cell(1, 1)],
].map(([from, to]) => ({ from, to }));

const LOOP_TOP_LEFT = [
  [cell(0, 0), cell(0, 1)], [cell(0, 1), cell(1, 1)],
  [cell(1, 1), cell(1, 0)], [cell(1, 0), cell(0, 0)],
].map(([from, to]) => ({ from, to }));

const LOOP_ROW_FOUR = [
  [cell(1, 0), cell(1, 1)], [cell(1, 1), cell(1, 2)], [cell(1, 2), cell(1, 3)],
  [cell(1, 3), cell(2, 3)], [cell(2, 3), cell(2, 2)], [cell(2, 2), cell(2, 1)],
  [cell(2, 1), cell(2, 0)], [cell(2, 0), cell(1, 0)],
].map(([from, to]) => ({ from, to }));

const LOOP_EQUAL_STRAIGHT_AND_TURN = [
  [cell(0, 0), cell(0, 1)], [cell(0, 1), cell(0, 2)],
  [cell(0, 2), cell(1, 2)], [cell(1, 2), cell(2, 2)],
  [cell(2, 2), cell(2, 1)], [cell(2, 1), cell(2, 0)],
  [cell(2, 0), cell(1, 0)], [cell(1, 0), cell(0, 0)],
].map(([from, to]) => ({ from, to }));

const LOOP_EDGE_GAP = [
  [cell(1, 0), cell(1, 1)], [cell(1, 1), cell(0, 1)], [cell(0, 1), cell(0, 2)],
  [cell(0, 2), cell(1, 2)], [cell(1, 2), cell(1, 3)], [cell(1, 3), cell(2, 3)],
  [cell(2, 3), cell(2, 2)], [cell(2, 2), cell(3, 2)], [cell(3, 2), cell(3, 1)],
  [cell(3, 1), cell(2, 1)], [cell(2, 1), cell(2, 0)], [cell(2, 0), cell(1, 0)],
].map(([from, to]) => ({ from, to }));

const LOOP_GRANDSTANDS_FIVE = [
  [cell(1, 2), cell(0, 2)], [cell(0, 2), cell(0, 3)], [cell(0, 3), cell(0, 4)],
  [cell(0, 4), cell(1, 4)], [cell(1, 4), cell(2, 4)], [cell(2, 4), cell(2, 3)],
  [cell(2, 3), cell(3, 3)], [cell(3, 3), cell(4, 3)], [cell(4, 3), cell(4, 2)],
  [cell(4, 2), cell(4, 1)], [cell(4, 1), cell(3, 1)], [cell(3, 1), cell(2, 1)],
  [cell(2, 1), cell(2, 0)], [cell(2, 0), cell(1, 0)], [cell(1, 0), cell(0, 0)],
  [cell(0, 0), cell(0, 1)], [cell(0, 1), cell(1, 1)], [cell(1, 1), cell(1, 2)],
].map(([from, to]) => ({ from, to }));

const LOOP_PEARL_WHITE_FIVE = [
  [cell(2, 0), cell(2, 1)], [cell(2, 1), cell(2, 2)], [cell(2, 2), cell(2, 3)], [cell(2, 3), cell(2, 4)],
  [cell(2, 4), cell(3, 4)], [cell(3, 4), cell(4, 4)], [cell(4, 4), cell(4, 3)], [cell(4, 3), cell(4, 2)],
  [cell(4, 2), cell(4, 1)], [cell(4, 1), cell(4, 0)], [cell(4, 0), cell(3, 0)], [cell(3, 0), cell(2, 0)],
].map(([from, to]) => ({ from, to }));

const ROW_REGIONS: Partial<Record<CellId, string>> = Object.fromEntries(
  rectangularCells(4, 4).map((id) => [id, `R${id.split(":")[0]}`]),
);

const REGIONS: Partial<Record<CellId, string>> = {
  "0:0": "A", "0:1": "A", "0:2": "B", "0:3": "B",
  "1:0": "A", "1:1": "A", "1:2": "B", "1:3": "C",
  "2:0": "D", "2:1": "D", "2:2": "B", "2:3": "C",
  "3:0": "D", "3:1": "D", "3:2": "C", "3:3": "C",
};

function anchorFor(family: RuleFamily): ClueAnchor {
  if (family === "cell-number" || family === "cell-dot") return { kind: "cell", cell: cell(1, 1) };
  if (family === "edge-number" || family === "edge-dot") return edge("vertical", 1, 2);
  if (family === "vertex-number" || family === "vertex-dot") return { kind: "vertex", row: 2, column: 2 };
  return { kind: "exterior", side: "left", index: 1 };
}

function clueKindFor(family: RuleFamily): PlacedClue["clueKind"] {
  return ({
    "cell-number": "cell-number",
    "edge-number": "edge-number",
    "vertex-number": "vertex-number",
    "cell-dot": "black-dot",
    "edge-dot": "black-dot",
    "vertex-dot": "vertex-dot",
    "exterior-number": "exterior-number",
    global: "cell-number",
  } as const)[family];
}

function exampleNumber(rule: RuleEntry) {
  const text = rule.text;
  if (rule.family === "cell-number") {
    if (/周围四格内|周围四格及自己/.test(text)) return 2;
    if (/周围八格被回路/.test(text)) return 5;
    if (/周围八格回路转弯/.test(text)) return 1;
    if (/周围八格未被/.test(text)) return 3;
    if (/周围八格/.test(text)) return 3;
    if (/周围九格/.test(text)) return 4;
    if (/kurodoko/.test(text)) return 3;
    if (/canal view/.test(text)) return 3;
    if (/白格连通组/.test(text)) return 4;
    if (/kurotto/.test(text)) return 4;
    if (/周围四格回路转弯/.test(text)) return 1;
    if (/周围四格被回路/.test(text)) return 2;
    if (/周围四格未被/.test(text)) return 2;
    if (/grandstands/.test(text)) return 3;
    if (/balance loop/.test(text)) return 3;
    if (/inturnal/.test(text)) return 2;
  }
  if (rule.family === "edge-number") {
    if (/涂黑格的数量|被回路经过的格数/.test(text)) return 1;
    if (/连通组的大小之和/.test(text)) return 9;
    if (/连通组的大小之差/.test(text)) return 10;
    if (/数字之和/.test(text)) return 5;
    if (/数字之差/.test(text)) return 1;
    if (/数字之积/.test(text)) return 6;
    if (/加\/减\/乘\/除/.test(text)) return 3;
    if (/至少一格包含/.test(text)) return 3;
    if (/面积之和/.test(text)) return 11;
    if (/面积之差/.test(text)) return 1;
    if (/分割线的长度/.test(text)) return 2;
    if (/这段回路的长度/.test(text)) return 2;
    if (/向外延伸的回路长度之和/.test(text)) return 2;
  }
  if (rule.family === "vertex-number") {
    if (/涂黑格的数量/.test(text)) return 2;
    if (/land measurement/.test(text)) return 7;
    if (/四个数字之和/.test(text)) return 10;
    if (/至少一格包含/.test(text)) return 3;
    if (/对角格子之和/.test(text)) return 5;
    if (/对角格子之差/.test(text)) return 2;
    if (/加\/减\/乘\/除/.test(text)) return 3;
    if (/四条边中回路使用的边数/.test(text)) return 2;
    if (/回路经过的格数/.test(text)) return 3;
    if (/回路转弯的格数/.test(text)) return 1;
  }
  if (rule.family === "cell-number" && rule.mechanic === "region" && /相邻的区域数量/.test(text)) return 2;
  if (rule.family === "vertex-number" && rule.mechanic === "region") {
    if (/不同区域的数量/.test(text)) return 3;
    if (/大小之和/.test(text)) return 12;
  }
  if (rule.family === "exterior-number") {
    if (rule.mechanic === "shade") {
      if (/涂黑格数$/.test(text)) return 2;
      if (/涂黑格段数/.test(text)) return 2;
      if (/最长/.test(text)) return 1;
      return 2;
    }
    if (rule.mechanic === "number") {
      if (/第一个数/.test(text)) return 3;
      if (/数量/.test(text)) return 3;
      if (/数字之和/.test(text)) return 8;
      return 3;
    }
    if (rule.mechanic === "loop") {
      if (/使用的格子数/.test(text)) return 2;
      if (/段数/.test(text)) return 1;
      return 1;
    }
    if (/不同的区域数量/.test(text)) return 3;
    if (/最长/.test(text)) return 2;
    return 1;
  }
  if (/数量|格数|边数/.test(text)) {
    if (/周围八格/.test(text)) return 3;
    if (/周围九格/.test(text)) return 4;
    if (/周围四格|四条边|覆盖的四格/.test(text)) return 2;
    if (/区域/.test(text)) return 3;
    return 2;
  }
  if (/大小|面积/.test(text)) return /之和/.test(text) ? 8 : /之差/.test(text) ? 2 : 4;
  if (/周长/.test(text)) return 8;
  if (/长度/.test(text)) return /之和/.test(text) ? 5 : 3;
  if (/之和/.test(text)) return 5;
  if (/之差|差1/.test(text)) return 1;
  if (/之积/.test(text)) return 6;
  if (/和为10/.test(text)) return 10;
  if (/和为5/.test(text)) return 5;
  if (/两倍/.test(text)) return 2;
  if (/摩天楼/.test(text)) return 3;
  if (/第一段/.test(text)) return 2;
  if (/最长/.test(text)) return 2;
  if (/最短/.test(text)) return 1;
  return 3;
}

function makeClues(rule: RuleEntry): PlacedClue[] {
  if (rule.family === "global") return [];
  const value = rule.family.includes("number") ? exampleNumber(rule) : undefined;
  const base: PlacedClue = {
    id: `${rule.id}-clue-a`,
    clueKind: clueKindFor(rule.family),
    anchor: anchorFor(rule.family),
    value,
    color: rule.dotApplicability[0],
  };
  if (rule.minimumSameColorCluesForScore === 2) {
    const secondAnchor: ClueAnchor = rule.family === "cell-dot"
      ? { kind: "cell", cell: cell(2, 2) }
      : rule.family === "edge-dot"
        ? edge("horizontal", 2, 1)
        : { kind: "vertex", row: 1, column: 1 };
    return [base, { ...base, id: `${rule.id}-clue-b`, anchor: secondAnchor }];
  }
  return [base];
}

function shadingSolution(rule: RuleEntry): PuzzleSolutionLayers {
  const text = rule.text;
  let black = CHECKER;
  if (/所有涂黑格连通/.test(text)) black = CONNECTED;
  else if (/所有留白格连通/.test(text)) black = SPARSE;
  else if (/不能接触/.test(text)) black = SPARSE;
  else if (/蛇/.test(text)) black = STRAIGHT_SNAKE;
  else if (/所在连通组.*中心对称/.test(text)) black = [cell(0, 1), cell(1, 0), cell(1, 1), cell(1, 2), cell(2, 1)];
  else if (/所在连通组.*轴对称/.test(text)) black = [cell(0, 1), cell(1, 0), cell(1, 1), cell(1, 2), cell(2, 1), cell(3, 1)];
  else if (/恰好有一个白格/.test(text)) black = [cell(0, 1), cell(1, 0), cell(1, 2)];
  else if (/一黑一白/.test(text)) black = [cell(1, 1), cell(0, 0), cell(0, 1)];
  else if (/均涂黑/.test(text)) black = [cell(1, 1), cell(1, 2), cell(2, 1), cell(2, 2)];
  else if (/都不能涂黑/.test(text)) black = [cell(0, 0), cell(3, 3)];
  if (rule.family === "cell-number") {
    if (/周围四格内/.test(text)) black = [cell(0, 1), cell(1, 2)];
    if (/周围四格及自己/.test(text)) black = [cell(1, 1), cell(1, 2)];
    if (/周围八格/.test(text)) black = [cell(0, 0), cell(0, 1), cell(2, 2)];
    if (/周围九格/.test(text)) black = [cell(0, 0), cell(0, 1), cell(1, 2), cell(2, 2)];
    if (/白格连通组/.test(text)) black = rectangularCells(4, 4).filter((id) => ![cell(1, 1), cell(0, 1), cell(1, 0), cell(1, 2)].includes(id));
    if (/kurodoko/.test(text)) black = [cell(0, 1), cell(1, 0), cell(1, 3), cell(3, 1)];
    if (/canal view/.test(text)) black = [cell(0, 1), cell(1, 0), cell(1, 2)];
    if (/kurotto/.test(text)) black = [cell(0, 1), cell(1, 0), cell(1, 2), cell(2, 1)];
  }
  if (rule.family === "cell-dot") {
    if (/必须被涂黑/.test(text)) black = [cell(1, 1), cell(0, 0)];
    if (/必须不被涂黑/.test(text)) black = [cell(0, 0), cell(3, 3)];
  }
  if (rule.family === "edge-number") {
    if (/涂黑格的数量/.test(text)) black = [cell(1, 1)];
    else if (/大小之和/.test(text)) black = [cell(1, 1), cell(0, 1), cell(0, 0), cell(2, 1), cell(2, 3), cell(3, 2)];
    else black = [cell(1, 1), cell(0, 1), cell(0, 0)];
  }
  if (rule.family === "vertex-number" || rule.family === "vertex-dot") {
    if (/更多的黑格/.test(text)) black = [cell(1, 1), cell(1, 2), cell(2, 1)];
    else if (/更多的白格/.test(text)) black = [cell(1, 1)];
    else black = [cell(1, 1), cell(2, 2)];
    if (/land measurement/.test(text)) black = [cell(1, 1), cell(0, 1), cell(0, 2), cell(0, 3), cell(1, 3), cell(2, 3), cell(2, 2)];
  }
  if (rule.family === "edge-dot") {
    if (/都不能涂黑/.test(text)) black = [cell(0, 0), cell(3, 3)];
    else if (/均涂黑/.test(text)) black = [cell(1, 1), cell(1, 2)];
    else if (/同色连通组/.test(text)) black = [cell(1, 1), cell(0, 2), cell(1, 3), cell(2, 2)];
    else black = [cell(1, 1)];
  }
  if (rule.family === "exterior-number") {
    black = /第一段/.test(text)
      ? [cell(1, 0), cell(1, 1), cell(3, 3)]
      : [cell(1, 0), cell(1, 2), cell(2, 1), cell(3, 3)];
  }
  return { shading: shadeRecord(black) };
}

function numberSolution(rule: RuleEntry): PuzzleSolutionLayers {
  const text = rule.text;
  let values = { ...LATIN };
  if (/1-N-1/.test(text)) values = { ...LATIN_THREE };
  if (/1-N-2/.test(text)) {
    values = { "0:0": 1, "0:1": 2, "1:1": 1, "1:2": 2, "2:2": 1, "2:3": 2, "3:0": 2, "3:3": 1 };
  }
  if (/必须不能填写|均不填入/.test(text)) delete values["1:1"];
  if (/恰好一格填入/.test(text)) delete values["1:2"];
  if (/必须填写一个奇数/.test(text)) values["1:1"] = 3;
  if (/必须填写一个偶数/.test(text)) values["1:1"] = 4;
  if (/必须大于/.test(text)) values = { ...values, "1:1": 4, "0:1": 1, "1:0": 2, "1:2": 2, "2:1": 3 };
  if (/必须小于/.test(text)) values = { ...values, "1:1": 1, "0:1": 4, "1:0": 3, "1:2": 2, "2:1": 4 };
  if (/差1|恰好有一对数差1/.test(text)) values = { ...values, "1:1": 2, "1:2": 3, "2:1": 1, "2:2": 4 };
  if (/两倍/.test(text)) values = { ...values, "1:1": 2, "1:2": 4 };
  if (/和为5/.test(text)) values = { ...values, "1:1": 2, "1:2": 3 };
  if (/和为10/.test(text)) values = { ...values, "1:1": 4, "1:2": 6 };
  if (/顺时针递增/.test(text)) values = { ...values, "1:1": 1, "1:2": 2, "2:2": 3, "2:1": 4 };
  if (/逆时针递增/.test(text)) values = { ...values, "1:1": 1, "2:1": 2, "2:2": 3, "1:2": 4 };
  if (rule.family === "cell-dot" && /所有具有同色点/.test(text)) values = { ...values, "1:1": 2, "2:2": 2 };
  if (rule.family === "edge-number") {
    if (/之和/.test(text)) values = { "1:1": 2, "1:2": 3 };
    else if (/之差/.test(text)) values = { "1:1": 2, "1:2": 3 };
    else if (/之积/.test(text)) values = { "1:1": 2, "1:2": 3 };
    else if (/至少一格包含/.test(text)) values = { "1:1": 3, "1:2": 1 };
    else values = { "1:1": 1, "1:2": 3 };
  }
  if (rule.family === "vertex-number") {
    if (/四个数字之和/.test(text)) values = { "1:1": 1, "1:2": 2, "2:1": 3, "2:2": 4 };
    else if (/至少一格包含/.test(text)) values = { "1:1": 3, "1:2": 1, "2:1": 2, "2:2": 4 };
    else if (/对角格子之和/.test(text)) values = { "1:1": 2, "1:2": 1, "2:1": 4, "2:2": 3 };
    else if (/对角格子之差/.test(text)) values = { "1:1": 1, "1:2": 2, "2:1": 4, "2:2": 3 };
    else values = { "1:1": 1, "1:2": 6, "2:1": 2, "2:2": 2 };
  }
  if (rule.family === "edge-dot") {
    if (/均不填入/.test(text)) values = {};
    else if (/恰好一格填入/.test(text)) values = { "1:1": 2 };
    else if (/差1/.test(text)) values = { "1:1": 2, "1:2": 3 };
    else if (/两倍/.test(text)) values = { "1:1": 2, "1:2": 4 };
    else if (/和为5/.test(text)) values = { "1:1": 2, "1:2": 3 };
    else if (/和为10/.test(text)) values = { "1:1": 4, "1:2": 6 };
    else if (/所有同色点/.test(text)) values = { "1:1": 2, "1:2": 3, "2:1": 3 };
    else values = { "1:1": 2, "1:2": 3 };
  }
  if (rule.family === "vertex-dot") {
    if (/更多的偶数/.test(text)) values = { "1:1": 2, "1:2": 4, "2:1": 6, "2:2": 3 };
    else if (/更多的奇数/.test(text)) values = { "1:1": 1, "1:2": 3, "2:1": 5, "2:2": 2 };
    else if (/更多的白格/.test(text)) values = { "1:1": 2 };
    else if (/更多的数字格/.test(text)) values = { "1:1": 1, "1:2": 2, "2:1": 3 };
    else if (/恰好有一对数差1/.test(text)) values = { "1:1": 1, "1:2": 2, "2:1": 5, "2:2": 8 };
    else if (/至少有两对数差1/.test(text)) values = { "1:1": 1, "1:2": 2, "2:1": 4, "2:2": 3 };
  }
  if (rule.family === "exterior-number") {
    if (/第一个数/.test(text)) values = { "1:0": 3, "1:1": 1, "1:2": 4, "1:3": 2 };
    else if (/摩天楼/.test(text)) values = { "1:0": 1, "1:1": 3, "1:2": 2, "1:3": 4 };
    else values = { "1:0": 1, "1:1": 3, "1:2": 2, "1:3": 4 };
  }
  return { numbers: values };
}

function loopSolution(rule: RuleEntry): PuzzleSolutionLayers {
  const text = rule.text;
  if (rule.family === "global") return { loop: LOOP_ALL_CELLS };
  if (rule.family === "cell-number" && /grandstands/.test(text)) return { loop: LOOP_GRANDSTANDS_FIVE };
  if (rule.family === "cell-dot") {
    if (/所在的未被回路经过的格形成的连通组/.test(text)) return { loop: LOOP_AROUND_CENTER };
    if (/两段线段必须等长|直行经过，且前后两格至少一格内转弯/.test(text)) return { loop: LOOP_BALANCED };
    if (/两段线段必须不等长|两端线段长度必须差1/.test(text)) return { loop: LOOP_INNER };
    if (/转弯经过，且前后两格都必须直行/.test(text)) return { loop: LOOP_CENTER_CORNER_LONG };
    if (/回路前后两格都必须转弯/.test(text)) return { loop: LOOP_CENTER_TURN };
    if (/必须被回路转弯经过/.test(text)) return { loop: LOOP_CENTER_TURN };
    if (/必须被回路直行经过|必须被回路经过/.test(text)) return { loop: LOOP_INNER };
  }
  if (rule.family === "edge-dot") {
    if (/必须不被回路穿过/.test(text)) return { loop: LOOP_PERIMETER };
    if (/一段线段的中点/.test(text)) return { loop: LOOP_ROW_FOUR };
    if (/分割成的两端经过的格数/.test(text)) return { loop: LOOP_BALANCED };
    if (/恰好有一格被回路经过/.test(text)) return { loop: LOOP_TOP_LEFT };
    if (/都被回路经过，且同为/.test(text)) return { loop: LOOP_CENTER_TURN };
    if (/都被回路经过，且一格转弯一格直行/.test(text)) return { loop: LOOP_CENTER_CORNER_LONG };
    if (/必须被回路穿过/.test(text)) return { loop: LOOP_CENTER_TURN };
  }
  if (rule.family === "vertex-dot") {
    if (/必须在回路外/.test(text)) return { loop: LOOP_TOP_LEFT };
    if (/必须在回路内/.test(text)) return { loop: LOOP_PERIMETER };
    if (/未经过的格子多于/.test(text)) return { loop: LOOP_PERIMETER };
    if (/回路经过的格子多于/.test(text)) return { loop: LOOP_ALL_CELLS };
  }
  if (rule.family === "edge-number") {
    if (/这段回路的长度/.test(text)) return { loop: LOOP_BALANCED };
    if (/向外延伸的回路长度之和/.test(text)) return { loop: LOOP_EDGE_GAP };
    if (/覆盖的两格中被回路经过/.test(text)) return { loop: LOOP_TOP_LEFT };
  }
  if (rule.family === "vertex-number") {
    if (/四条边中回路使用/.test(text)) return { loop: LOOP_INNER };
    if (/回路经过的格数|回路转弯的格数/.test(text)) return { loop: LOOP_CENTER_CORNER_LONG };
  }
  if (rule.family === "exterior-number") {
    if (/使用的格子数/.test(text)) return { loop: LOOP_PERIMETER };
    return { loop: LOOP_ALL_CELLS };
  }
  if (/必须不被回路|不能被回路|必须不被回路穿过/.test(text)) return { loop: LOOP_PERIMETER };
  if (/转弯/.test(text) && !/转弯的格/.test(text)) return { loop: LOOP_CENTER_TURN };
  if (/直行/.test(text) || /中点|线段长度|两段线段|两端|必须被回路/.test(text)) return { loop: LOOP_INNER };
  return { loop: LOOP_PERIMETER };
}

function regionSolution(rule: RuleEntry): PuzzleSolutionLayers {
  const text = rule.text;
  if (rule.ordinal === 120) {
    const a = new Set([cell(0, 0), cell(0, 1), cell(1, 0), cell(1, 1), cell(2, 0)]);
    return { regions: Object.fromEntries(rectangularCells(4, 4).map((id) => [id, a.has(id) ? "A" : "B"])) };
  }
  if (/每个区域都是矩形/.test(text)) {
    return { regions: Object.fromEntries(rectangularCells(4, 4).map((id) => [id, Number(id.split(":")[1]) < 2 ? "A" : "B"])) };
  }
  if (/所有区域形状不同/.test(text)) {
    return { regions: {
      "0:0": "A", "0:1": "B", "0:2": "B", "0:3": "C",
      "1:0": "D", "1:1": "D", "1:2": "C", "1:3": "C",
      "2:0": "D", "2:1": "D", "2:2": "D", "2:3": "D",
      "3:0": "D", "3:1": "D", "3:2": "D", "3:3": "D",
    } };
  }
  if (/中心对称图形/.test(text) || /恰好有一个线索/.test(text)) return { regions: ROW_REGIONS };
  if (rule.family === "edge-number" || rule.family === "edge-dot") {
    if (rule.family === "edge-dot" && /其所在区域/.test(text)) {
      const a = /轴对称/.test(text)
        ? new Set([cell(0, 1), cell(0, 2), cell(1, 0), cell(1, 1), cell(1, 2), cell(1, 3)])
        : new Set([cell(1, 1), cell(1, 2)]);
      return { regions: Object.fromEntries(rectangularCells(4, 4).map((id) => [id, a.has(id) ? "A" : "B"])) };
    }
    if (rule.family === "edge-number") {
      const a = new Set([cell(0, 0), cell(0, 1), cell(1, 0), cell(1, 1), cell(2, 0), cell(3, 0)]);
      const b = new Set([cell(0, 2), cell(0, 3), cell(1, 2), cell(1, 3), cell(2, 3)]);
      return { regions: Object.fromEntries(rectangularCells(4, 4).map((id) => [id, a.has(id) ? "A" : b.has(id) ? "B" : "C"])) };
    }
    return { regions: Object.fromEntries(rectangularCells(4, 4).map((id) => [id, Number(id.split(":")[1]) < 2 ? "A" : "B"])) };
  }
  if (rule.family === "vertex-dot" && /零条线/.test(text)) return { regions: Object.fromEntries(rectangularCells(4, 4).map((id) => [id, "A"])) };
  if (rule.family === "vertex-dot" && /四条线/.test(text)) return { regions: Object.fromEntries(rectangularCells(4, 4).map((id) => [id, `${id}`])) };
  if (rule.family === "vertex-dot" && /其所在区域/.test(text)) {
    const a = /轴对称/.test(text)
      ? new Set([
        cell(0, 1), cell(0, 2),
        cell(1, 0), cell(1, 1), cell(1, 2), cell(1, 3),
        cell(2, 1), cell(2, 2), cell(3, 1), cell(3, 2),
      ])
      : new Set([cell(1, 1), cell(1, 2), cell(2, 1), cell(2, 2)]);
    return { regions: Object.fromEntries(rectangularCells(4, 4).map((id) => [id, a.has(id) ? "A" : "B"])) };
  }
  if (rule.family === "cell-dot" && /周围四格必须同属一区/.test(text)) return { regions: Object.fromEntries(rectangularCells(4, 4).map((id) => [id, "A"])) };
  if (rule.family === "cell-dot" && /所有具有同色点的区域/.test(text)) return { regions: ROW_REGIONS };
  if (rule.family === "cell-dot" && /其所在区域必须/.test(text)) {
    const a = /轴对称/.test(text)
      ? new Set([cell(0, 0), cell(0, 1), cell(0, 2), cell(1, 1), cell(2, 1)])
      : new Set([cell(0, 1), cell(1, 0), cell(1, 1), cell(1, 2), cell(2, 1)]);
    return { regions: Object.fromEntries(rectangularCells(4, 4).map((id) => [id, a.has(id) ? "A" : "B"])) };
  }
  return { regions: REGIONS };
}

function cleanRuleText(text: string) {
  return text.replace(/（[^）]*）/g, "").replace(/\s+/g, " ").trim();
}

function globalExample(rule: RuleEntry): RuleExample {
  let rows = 2;
  let columns = 2;
  let activeCells = rectangularCells(rows, columns);
  let solution: PuzzleSolutionLayers = {};
  let clues: PlacedClue[] = [];

  switch (rule.ordinal) {
    case 1:
      rows = 1; columns = 2; activeCells = rectangularCells(rows, columns); solution = { shading: shadeRecord(activeCells, rows, columns) }; break;
    case 2:
      rows = 1; columns = 2; activeCells = rectangularCells(rows, columns); solution = { shading: shadeRecord([], rows, columns) }; break;
    case 3:
      solution = { shading: shadeRecord([cell(0, 0), cell(0, 1), cell(1, 0)], rows, columns) }; break;
    case 4:
      solution = { shading: shadeRecord([cell(0, 0)], rows, columns) }; break;
    case 5:
      rows = 1; columns = 3; activeCells = rectangularCells(rows, columns); solution = { shading: shadeRecord([cell(0, 0), cell(0, 1)], rows, columns) }; break;
    case 6:
      rows = 1; columns = 4; activeCells = rectangularCells(rows, columns); solution = { shading: shadeRecord([cell(0, 0), cell(0, 1), cell(0, 2)], rows, columns) }; break;
    case 7:
      solution = { shading: shadeRecord([cell(0, 0), cell(1, 1)], rows, columns) }; break;
    case 8:
      solution = { shading: shadeRecord([cell(0, 0)], rows, columns) }; break;
    case 9:
      rows = 1; columns = 3; activeCells = rectangularCells(rows, columns); solution = { shading: shadeRecord(activeCells, rows, columns) }; break;
    case 10:
      activeCells = [cell(0, 0), cell(0, 1), cell(1, 0)]; solution = { numbers: { "0:0": 1, "0:1": 2, "1:0": 2 } }; break;
    case 11:
      rows = 3; columns = 3; activeCells = rectangularCells(rows, columns); solution = { numbers: { "0:0": 1, "0:1": 2, "1:1": 1, "1:2": 2, "2:0": 2, "2:2": 1 } }; break;
    case 12:
      rows = 3; columns = 3; activeCells = rectangularCells(rows, columns); solution = { numbers: { "0:0": 1, "1:1": 1, "2:2": 1 } }; break;
    case 13:
      solution = { numbers: { "0:0": 1, "0:1": 2, "1:1": 1 } }; break;
    case 14:
      rows = 3; columns = 3; activeCells = rectangularCells(rows, columns); solution = { loop: [
        [cell(0, 0), cell(0, 1)], [cell(0, 1), cell(0, 2)], [cell(0, 2), cell(1, 2)], [cell(1, 2), cell(2, 2)],
        [cell(2, 2), cell(2, 1)], [cell(2, 1), cell(2, 0)], [cell(2, 0), cell(1, 0)], [cell(1, 0), cell(0, 0)],
      ].map(([from, to]) => ({ from, to })) }; break;
    case 15:
      solution = { loop: LOOP_TOP_LEFT }; break;
    case 16:
      solution = { regions: { "0:0": "A", "1:0": "A", "0:1": "B", "1:1": "B" } }; break;
    case 17:
      rows = 3; columns = 3; activeCells = rectangularCells(rows, columns); solution = { regions: {
        "0:0": "B", "0:1": "A", "0:2": "C", "1:0": "A", "1:1": "A", "1:2": "A", "2:0": "D", "2:1": "A", "2:2": "E",
      } }; break;
    case 18:
      solution = { regions: { "0:0": "A", "0:1": "A", "1:0": "B", "1:1": "B" } };
      clues = [0, 1].map((row) => ({ id: `${rule.id}-aux-${row}`, clueKind: "cell-number", anchor: { kind: "cell", cell: cell(row, 0) }, value: row + 1 }));
      break;
    case 19:
      solution = { regions: { "0:0": "A", "0:1": "B", "1:0": "B", "1:1": "B" } }; break;
  }

  return {
    puzzle: { geometry: { rows, columns, activeCells }, mechanic: rule.mechanic, clues, solution },
    note: `最小示例：${cleanRuleText(rule.text)}`,
    highlightedCells: [],
  };
}

function highlightedFor(rule: RuleEntry, clues: PlacedClue[], solution: PuzzleSolutionLayers, activeCells: CellId[]) {
  if (rule.family === "global" || clues.length === 0) return [];
  if (rule.ordinal === 85 || rule.ordinal === 86) {
    const active = new Set(activeCells);
    return [...new Set(clues.flatMap((clue) => {
      if (clue.anchor.kind !== "cell") return [];
      const [row, column] = clue.anchor.cell.split(":").map(Number);
      return [cell(row, column), cell(row - 1, column), cell(row + 1, column), cell(row, column - 1), cell(row, column + 1)];
    }))].filter((id) => active.has(id));
  }
  const anchor = clues[0].anchor;
  const active = new Set(activeCells);
  if (anchor.kind === "edge" || anchor.kind === "vertex") return cellsTouchedByAnchor(anchor).filter((id) => active.has(id));
  if (anchor.kind === "exterior") {
    return activeCells.filter((id) => {
      const [row, column] = id.split(":").map(Number);
      return anchor.side === "left" || anchor.side === "right" ? row === anchor.index : column === anchor.index;
    });
  }
  const [row, column] = anchor.cell.split(":").map(Number);
  if (rule.mechanic === "shade" && rule.family === "cell-number") {
    if (/周围八格|周围九格/.test(rule.text)) {
      return activeCells.filter((id) => {
        const [r, c] = id.split(":").map(Number);
        return Math.abs(r - row) <= 1 && Math.abs(c - column) <= 1;
      });
    }
    if (/canal view/.test(rule.text)) {
      const result = [anchor.cell];
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        for (let r = row + dr, c = column + dc; active.has(cell(r, c)); r += dr, c += dc) {
          const id = cell(r, c);
          if (solution.shading?.[id] !== "black") break;
          result.push(id);
        }
      }
      return result;
    }
    if (/四个方向/.test(rule.text)) return activeCells.filter((id) => {
      const [r, c] = id.split(":").map(Number);
      return r === row || c === column;
    });
    if (/连通组/.test(rule.text)) return activeCells.filter((id) => solution.shading?.[id] === (/白格/.test(rule.text) ? "white" : "black") || id === anchor.cell);
  }
  if (/grandstands/.test(rule.text)) return activeCells.filter((id) => {
    const [r, c] = id.split(":").map(Number);
    return r === row || c === column;
  });
  const local = [cell(row, column), cell(row - 1, column), cell(row + 1, column), cell(row, column - 1), cell(row, column + 1)];
  return local.filter((id) => active.has(id));
}

function noteFor(rule: RuleEntry) {
  const prefix = rule.family === "global"
    ? "完整小盘面展示："
    : rule.family.includes("number")
      ? `数字线索为 ${exampleNumber(rule)}；高亮处展示对应局部答案。`
      : "高亮处展示点线索与对应局部答案。";
  const colorNote = rule.dotApplicability.length === 2
    ? "黑点与白点均可使用这一解释。"
    : rule.dotApplicability[0] === "black"
      ? "仅黑点可使用。"
      : rule.dotApplicability[0] === "white"
        ? "仅白点可使用。"
        : "";
  const multiplicity = rule.minimumSameColorCluesForScore === 2 ? "图中放置两个同色点，因此该牌可计分。" : "";
  const orientationNote = rule.ordinal === 85 || rule.ordinal === 86 ? "图中两个点分别展示直行与转弯经过。" : "";
  return `${prefix}${cleanRuleText(rule.text)} ${colorNote}${multiplicity}${orientationNote}`.trim();
}

export function createRuleExample(rule: RuleEntry): RuleExample {
  if (rule.family === "global") return globalExample(rule);
  const solution = rule.mechanic === "shade"
    ? shadingSolution(rule)
    : rule.mechanic === "number"
      ? numberSolution(rule)
      : rule.mechanic === "loop"
        ? loopSolution(rule)
        : regionSolution(rule);
  let clues = makeClues(rule);
  let rows = 4;
  let columns = 4;
  let activeCells = rectangularCells(rows, columns);
  let finalSolution = solution;
  if (rule.ordinal === 35) {
    rows = 5; columns = 5; activeCells = rectangularCells(rows, columns); finalSolution = { loop: LOOP_GRANDSTANDS_FIVE };
    clues = [{ ...clues[0], anchor: { kind: "cell", cell: cell(2, 2) }, value: 3 }];
  }
  if (rule.ordinal === 93) {
    rows = 5; columns = 5; activeCells = rectangularCells(rows, columns); finalSolution = { loop: LOOP_PEARL_WHITE_FIVE };
    clues = [{ ...clues[0], anchor: { kind: "cell", cell: cell(2, 2) } }];
  }
  if (rule.ordinal === 84) {
    finalSolution = { loop: LOOP_TOP_LEFT };
    clues = [{ ...clues[0], anchor: { kind: "cell", cell: cell(2, 2) } }];
  }
  if (rule.ordinal === 85) {
    finalSolution = { loop: LOOP_EQUAL_STRAIGHT_AND_TURN };
    clues = [
      { ...clues[0], id: `${rule.id}-straight`, anchor: { kind: "cell", cell: cell(0, 1) } },
      { ...clues[0], id: `${rule.id}-turn`, anchor: { kind: "cell", cell: cell(0, 0) } },
    ];
  }
  if (rule.ordinal === 86) {
    finalSolution = { loop: LOOP_ROW_FOUR };
    clues = [
      { ...clues[0], id: `${rule.id}-straight`, anchor: { kind: "cell", cell: cell(1, 1) } },
      { ...clues[0], id: `${rule.id}-turn`, anchor: { kind: "cell", cell: cell(1, 0) } },
    ];
  }
  if (rule.ordinal === 114) clues = [{ ...clues[0], anchor: edge("vertical", 1, 2) }];
  if (rule.ordinal === 115 || rule.ordinal === 116) clues = [{ ...clues[0], anchor: edge("vertical", 1, 1) }];
  if (rule.ordinal === 32) {
    clues = [{ ...clues[0], anchor: { kind: "cell", cell: cell(2, 1) }, value: 1 }];
    finalSolution = { loop: LOOP_TOP_LEFT };
  }
  if (rule.ordinal === 37) clues = [{ ...clues[0], anchor: { kind: "cell", cell: cell(0, 1) }, value: 2 }];
  return {
    puzzle: {
      geometry: { rows, columns, activeCells },
      mechanic: rule.mechanic,
      clues,
      solution: finalSolution,
    },
    note: noteFor(rule),
    highlightedCells: highlightedFor(rule, clues, finalSolution, activeCells),
  };
}

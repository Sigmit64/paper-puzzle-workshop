import { useMemo, useState } from "react";
import { parseCellId } from "./game/geometry";
import { createRuleExample } from "./game/examples";
import { RULESET, type RuleEntry, type RuleFamily } from "./game/ruleset";
import { auditRuleset } from "./game/ruleset-audit";
import type { BoardMechanic, CellId } from "./game/types";
import type { ClueAnchor, PlacedClue, RuleExample } from "./game/puzzle-model";
import { displayRuleText } from "./rule-display";

const FAMILY_NAMES: Record<RuleFamily, string> = {
  global: "全局规则",
  "cell-number": "格内数字",
  "edge-number": "边上数字",
  "vertex-number": "格点数字",
  "cell-dot": "格内点",
  "edge-dot": "边上点",
  "vertex-dot": "格点上点",
  "exterior-number": "外提示数",
};
const MECHANIC_NAMES: Record<BoardMechanic, string> = { shade: "涂黑", number: "填数", loop: "回路", region: "分区" };

function anchorPosition(anchor: ClueAnchor, pad: number, size: number, rows: number, columns: number) {
  if (anchor.kind === "cell") {
    const { row, column } = parseCellId(anchor.cell);
    return { x: pad + column * size + size / 2, y: pad + row * size + size / 2 };
  }
  if (anchor.kind === "edge") return {
    x: pad + (anchor.orientation === "vertical" ? anchor.column * size : (anchor.column + .5) * size),
    y: pad + (anchor.orientation === "horizontal" ? anchor.row * size : (anchor.row + .5) * size),
  };
  if (anchor.kind === "vertex") return { x: pad + anchor.column * size, y: pad + anchor.row * size };
  if (anchor.side === "left") return { x: pad - 15, y: pad + (anchor.index + .5) * size };
  if (anchor.side === "right") return { x: pad + columns * size + 15, y: pad + (anchor.index + .5) * size };
  if (anchor.side === "top") return { x: pad + (anchor.index + .5) * size, y: pad - 15 };
  return { x: pad + (anchor.index + .5) * size, y: pad + rows * size + 15 };
}

function ClueMark({ clue, pad, size, rows, columns, containedValue }: { clue: PlacedClue; pad: number; size: number; rows: number; columns: number; containedValue?: number }) {
  const { x, y } = anchorPosition(clue.anchor, pad, size, rows, columns);
  const isDot = clue.color !== undefined;
  if (isDot) {
    const radius = clue.anchor.kind === "cell" ? 13 : 7;
    return <g className={`example-clue dot-${clue.color}`}><circle cx={x} cy={y} r={radius} />{containedValue !== undefined && <text className="dot-value" x={x} y={y + 5}>{containedValue}</text>}</g>;
  }
  return <g className="example-clue number-clue"><circle cx={x} cy={y} r="10" /><text x={x} y={y + 4}>{clue.value}</text></g>;
}

export function ExampleBoard({ example }: { example: RuleExample }) {
  const { puzzle } = example;
  const size = 40;
  const pad = 28;
  const width = puzzle.geometry.columns * size + pad * 2;
  const height = puzzle.geometry.rows * size + pad * 2;
  const active = new Set(puzzle.geometry.activeCells);
  const regions = puzzle.solution.regions ?? {};
  const highlighted = new Set(example.highlightedCells ?? []);

  function regionAt(row: number, column: number) {
    return regions[`${row}:${column}` as CellId];
  }

  return (
    <svg className="rule-example-board" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={example.note}>
      {puzzle.geometry.activeCells.map((id) => {
        const { row, column } = parseCellId(id);
        const shade = puzzle.solution.shading?.[id];
        const region = regions[id];
        return <rect key={`cell-${id}`} className={`example-cell ${shade === "black" ? "is-black" : ""} ${region ? `region-${region}` : ""} ${highlighted.has(id) ? "is-highlighted" : ""}`} x={pad + column * size} y={pad + row * size} width={size} height={size} />;
      })}

      {Object.entries(regions).flatMap(([rawId, region]) => {
        const id = rawId as CellId;
        const { row, column } = parseCellId(id);
        const x = pad + column * size;
        const y = pad + row * size;
        const sides = [
          { key: "t", show: row === 0 || regionAt(row - 1, column) !== region, x1: x, y1: y, x2: x + size, y2: y },
          { key: "l", show: column === 0 || regionAt(row, column - 1) !== region, x1: x, y1: y, x2: x, y2: y + size },
          { key: "r", show: column === puzzle.geometry.columns - 1 || regionAt(row, column + 1) !== region, x1: x + size, y1: y, x2: x + size, y2: y + size },
          { key: "b", show: row === puzzle.geometry.rows - 1 || regionAt(row + 1, column) !== region, x1: x, y1: y + size, x2: x + size, y2: y + size },
        ];
        return sides.filter((side) => side.show).map((side) => <line className="region-border" key={`${id}-${side.key}`} x1={side.x1} y1={side.y1} x2={side.x2} y2={side.y2} />);
      })}

      {puzzle.solution.loop?.map((segment, index) => {
        const from = parseCellId(segment.from);
        const to = parseCellId(segment.to);
        return <line className="example-loop" key={`loop-${index}`} x1={pad + from.column * size + size / 2} y1={pad + from.row * size + size / 2} x2={pad + to.column * size + size / 2} y2={pad + to.row * size + size / 2} />;
      })}

      {Object.entries(puzzle.solution.numbers ?? {}).map(([rawId, value]) => {
        const id = rawId as CellId;
        if (!active.has(id)) return null;
        const { row, column } = parseCellId(id);
        const covered = puzzle.clues.some((clue) => clue.anchor.kind === "cell" && clue.anchor.cell === id);
        if (covered) return null;
        return <text className="solution-number" key={`value-${id}`} x={pad + column * size + size / 2} y={pad + row * size + size / 2 + 5}>{value}</text>;
      })}

      {puzzle.clues.map((clue) => <ClueMark key={clue.id} clue={clue} pad={pad} size={size} rows={puzzle.geometry.rows} columns={puzzle.geometry.columns} containedValue={clue.anchor.kind === "cell" ? puzzle.solution.numbers?.[clue.anchor.cell] : undefined} />)}
    </svg>
  );
}

function RuleCard({ rule }: { rule: RuleEntry }) {
  const example = useMemo(() => createRuleExample(rule), [rule]);
  return (
    <article className="rule-example-card">
      <div className="rule-meta"><span>#{rule.ordinal}</span><span>{MECHANIC_NAMES[rule.mechanic]}</span>{rule.minimumSameColorCluesForScore === 2 && <span>同色点×2才计分</span>}</div>
      <h3>{displayRuleText(rule.text)}</h3>
      <ExampleBoard example={example} />
      <p>{example.note}</p>
    </article>
  );
}

export default function Rulebook() {
  const [family, setFamily] = useState<RuleFamily | "all">("all");
  const [mechanic, setMechanic] = useState<BoardMechanic | "all">("all");
  const visible = RULESET.filter((rule) => (family === "all" || rule.family === family) && (mechanic === "all" || rule.mechanic === mechanic));
  const audit = useMemo(() => auditRuleset(), []);

  return (
    <main className="rulebook-shell">
      <header className="rulebook-header">
        <div><p className="eyebrow">完整审查合集</p><h1>规则示例图鉴</h1><p>共 {RULESET.length} 条规则；每张卡展示线索及一个完成的局部答案。</p><p className={audit.errors.length ? "audit-badge audit-failed" : "audit-badge"}>结构检查 {audit.passed}/{audit.total}{audit.errors.length ? `：${audit.errors[0]}` : " 通过"}</p></div>
        <a className="back-link" href="./">← 返回游戏</a>
      </header>
      <section className="rulebook-filters" aria-label="筛选规则">
        <label>线索载体<select value={family} onChange={(event) => setFamily(event.target.value as RuleFamily | "all")}><option value="all">全部</option>{Object.entries(FAMILY_NAMES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>主要玩法<select value={mechanic} onChange={(event) => setMechanic(event.target.value as BoardMechanic | "all")}><option value="all">全部</option>{Object.entries(MECHANIC_NAMES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <strong>当前显示 {visible.length} 条</strong>
      </section>
      {Object.entries(FAMILY_NAMES).map(([familyKey, familyName]) => {
        const rules = visible.filter((rule) => rule.family === familyKey);
        if (!rules.length) return null;
        return <section className="rule-family-section" key={familyKey}><div className="section-title"><div><p className="eyebrow">{rules.length} 条</p><h2>{familyName}</h2></div></div><div className="rule-example-grid">{rules.map((rule) => <RuleCard key={rule.id} rule={rule} />)}</div></section>;
      })}
    </main>
  );
}

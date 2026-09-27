import { createRuleExample } from "./examples";
import { edgeId, validateInternalAnchor } from "./puzzle-model";
import { RULESET } from "./ruleset";

export interface RulesetAudit {
  total: number;
  passed: number;
  errors: string[];
}

function anchorKey(anchor: ReturnType<typeof createRuleExample>["puzzle"]["clues"][number]["anchor"]) {
  if (anchor.kind === "cell") return `cell:${anchor.cell}`;
  if (anchor.kind === "edge") return `edge:${edgeId(anchor)}`;
  if (anchor.kind === "vertex") return `vertex:${anchor.row}:${anchor.column}`;
  return `exterior:${anchor.side}:${anchor.index}`;
}

export function auditRuleset(): RulesetAudit {
  const errors: string[] = [];
  for (const rule of RULESET) {
    const example = createRuleExample(rule);
    const { puzzle } = example;
    const keys = puzzle.clues.map((clue) => anchorKey(clue.anchor));
    if (new Set(keys).size !== keys.length) errors.push(`#${rule.ordinal} 有重叠线索`);
    if (puzzle.clues.some((clue) => !validateInternalAnchor(puzzle.geometry, clue.anchor))) errors.push(`#${rule.ordinal} 线索不在有效位置`);
    if (puzzle.clues.some((clue) => clue.clueKind.includes("number") && clue.value === undefined)) errors.push(`#${rule.ordinal} 数字线索缺值`);
    if (rule.minimumSameColorCluesForScore === 2) {
      const colors = puzzle.clues.map((clue) => clue.color).filter(Boolean);
      if (colors.length < 2 || !colors.every((color) => color === colors[0])) errors.push(`#${rule.ordinal} 未展示两个同色点`);
    }
    if (rule.mechanic === "shade" && !puzzle.solution.shading) errors.push(`#${rule.ordinal} 缺少涂黑答案层`);
    if (rule.mechanic === "number" && !puzzle.solution.numbers) errors.push(`#${rule.ordinal} 缺少填数答案层`);
    if (rule.mechanic === "loop" && !puzzle.solution.loop) errors.push(`#${rule.ordinal} 缺少回路答案层`);
    if (rule.mechanic === "region" && !puzzle.solution.regions) errors.push(`#${rule.ordinal} 缺少分区答案层`);
  }
  const failed = new Set(errors.map((error) => error.match(/^#\d+/)?.[0])).size;
  return { total: RULESET.length, passed: RULESET.length - failed, errors };
}

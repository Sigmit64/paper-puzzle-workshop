import rulesText from "../../ruleset.txt?raw";
import type { BoardMechanic } from "./types";
import type { DotColor } from "./puzzle-model";

export type RuleFamily =
  | "global"
  | "cell-number"
  | "edge-number"
  | "vertex-number"
  | "cell-dot"
  | "edge-dot"
  | "vertex-dot"
  | "exterior-number";

export interface RuleEntry {
  id: string;
  ordinal: number;
  family: RuleFamily;
  mechanic: BoardMechanic;
  text: string;
  dotApplicability: DotColor[];
  minimumSameColorCluesForScore: number;
  score: null;
}

const FAMILY_HEADINGS: Array<[string, RuleFamily]> = [
  ["全局规则", "global"],
  ["格内数字", "cell-number"],
  ["边上数字", "edge-number"],
  ["格点上的数字", "vertex-number"],
  ["格内点", "cell-dot"],
  ["边上点", "edge-dot"],
  ["格点上点", "vertex-dot"],
  ["外提示数", "exterior-number"],
];

const MECHANIC_HEADINGS: Record<string, BoardMechanic> = {
  "涂黑：": "shade",
  "填数：": "number",
  "回路：": "loop",
  "分区：": "region",
};

function slug(value: string) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function dotApplicability(family: RuleFamily, text: string): DotColor[] {
  if (!family.includes("dot")) return [];
  if (text.endsWith("（黑）")) return ["black"];
  if (text.endsWith("（白）")) return ["white"];
  return ["black", "white"];
}

export function parseRuleset(source: string): RuleEntry[] {
  let family: RuleFamily | null = null;
  let mechanic: BoardMechanic | null = null;
  const rules: RuleEntry[] = [];

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const familyHeading = FAMILY_HEADINGS.find(([heading]) => line.startsWith(`${heading}：`));
    if (familyHeading) {
      family = familyHeading[1];
      mechanic = null;
      continue;
    }
    if (MECHANIC_HEADINGS[line]) {
      mechanic = MECHANIC_HEADINGS[line];
      continue;
    }
    if (!family || !mechanic) continue;
    const ordinal = rules.length + 1;
    rules.push({
      id: `${family}-${mechanic}-${slug(line)}`,
      ordinal,
      family,
      mechanic,
      text: line,
      dotApplicability: dotApplicability(family, line),
      minimumSameColorCluesForScore: /所有具有同色点|所有同色点/.test(line) ? 2 : 1,
      score: null,
    });
  }
  return rules;
}

export const RULESET = parseRuleset(rulesText);

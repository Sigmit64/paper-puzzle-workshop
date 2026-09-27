import { clueAnchorOf } from "./puzzle-model";
import type { BoardMechanic, BoardState, ClueInstance, ClueKind } from "./types";

export interface CompiledClueRule {
  key: string;
  clueKind: ClueKind;
  sourceCardInstanceId: string;
}

export interface CompiledPuzzle {
  board: BoardState;
  mechanic: BoardMechanic;
  globalRuleKeys: string[];
  clueRules: CompiledClueRule[];
  solutionLimit: number;
  timeBudgetMs: number;
}

export interface SolveOutcome {
  count: number;
  timedOut: boolean;
  exploredNodes: number;
  elapsedMs: number;
}

export function hasGlobalRule(model: CompiledPuzzle, key: string) {
  return model.globalRuleKeys.includes(key);
}

export function hasClueRule(model: CompiledPuzzle, key: string, clueKind?: ClueKind) {
  return model.clueRules.some((rule) => rule.key === key && (!clueKind || rule.clueKind === clueKind));
}

export function clueCell(clue: ClueInstance) {
  const anchor = clueAnchorOf(clue);
  return anchor?.kind === "cell" ? anchor.cell : undefined;
}

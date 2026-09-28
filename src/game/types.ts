export type BoardMechanic = "shade" | "loop" | "number" | "region";
export type CardKind = "global" | "clue" | "tool";
export type ClueKind =
  | "cell-number"
  | "white-dot"
  | "black-dot"
  | "edge-white-dot"
  | "edge-black-dot"
  | "vertex-white-dot"
  | "vertex-black-dot"
  | "edge-number"
  | "vertex-number"
  | "exterior-number"
  | "given-edge";
export type ToolEffect = "remove-clue" | "remove-cell" | "remove-clue-card" | "remove-global-card";
export type CellId = `${number}:${number}`;
export type DotColor = "black" | "white";
export type Side = "top" | "right" | "bottom" | "left";
export type ClueAnchor =
  | { kind: "cell"; cell: CellId }
  | { kind: "edge"; orientation: "horizontal" | "vertical"; row: number; column: number }
  | { kind: "vertex"; row: number; column: number }
  | { kind: "exterior"; side: Side; index: number };

export interface CardDefinition {
  id: string;
  name: string;
  kind: CardKind;
  score: number | null;
  summary: string;
  supportedMechanics: BoardMechanic[];
  establishesMechanic?: BoardMechanic;
  ruleKey?: string;
  clue?: {
    kind: ClueKind;
    min: number;
    max: number;
    interpretations: Partial<Record<BoardMechanic, string>>;
    ruleKeys?: Partial<Record<BoardMechanic, string>>;
  };
  toolEffect?: ToolEffect;
}

export interface CardInstance {
  id: string;
  definitionId: string;
  /** A clue card is composed from 2–4 entries sharing one physical clue kind. */
  entryDefinitionIds?: string[];
}

export interface BoardCard {
  instanceId: string;
  definitionId: string;
  entryDefinitionIds?: string[];
  placedClueId?: string;
}

export interface DraftPoint {
  x: number;
  y: number;
}

export interface DraftStroke {
  id: string;
  points: DraftPoint[];
}

export interface ClueInstance {
  id: string;
  kind: ClueKind;
  cellId?: CellId;
  edgeId?: string;
  anchor?: ClueAnchor;
  value?: number;
  sourceCardInstanceId: string;
}

export interface BoardState {
  id: string;
  name: string;
  rows: number;
  columns: number;
  activeCells: CellId[];
  ruleCapacity: number;
  mechanic: BoardMechanic | null;
  globalCards: BoardCard[];
  clueCards: BoardCard[];
  clues: ClueInstance[];
  draftStrokes: DraftStroke[];
  revision: number;
}

export interface ShopOffer {
  id: string;
  definitionId: string;
  entryDefinitionIds?: string[];
  cost: number;
}

export type PendingAction =
  | {
      kind: "place-clue";
      boardId: string;
      card: CardInstance;
      fromSetup: boolean;
      replaceInstanceId?: string;
      value: number;
    }
  | {
      kind: "use-tool";
      boardId: string;
      card: CardInstance;
      effect: ToolEffect;
    };

export type EvaluationStatus = "unsat" | "multiple" | "unique" | "unsupported" | "timeout";

export interface EvaluationResult {
  boardName: string;
  status: EvaluationStatus;
  baseScore: number;
  awardedScore: number;
  detail: string;
  solutions?: import("./puzzle-model").PuzzleSolutionLayers[];
  solverStats?: {
    solutionsFound: number;
    exploredNodes: number;
    elapsedMs: number;
  };
}

export interface GameState {
  phase: "setup" | "playing" | "finished";
  round: number;
  maxRounds: number;
  drawPerRound: number;
  score: number;
  boards: BoardState[];
  selectedBoardId: string;
  deck: CardInstance[];
  hand: CardInstance[];
  discard: CardInstance[];
  shop: ShopOffer[];
  selectedForTrade: string[];
  pending: PendingAction | null;
  message: string;
  lastEvaluation: EvaluationResult | null;
  serial: number;
}

export type GameAction =
  | { type: "choose-start-board"; boardId: string }
  | { type: "select-board"; boardId: string }
  | { type: "set-pending-clue-value"; value: number }
  | { type: "place-pending-clue"; anchor: ClueAnchor }
  | { type: "cancel-pending" }
  | { type: "play-card"; cardInstanceId: string; replaceInstanceId?: string }
  | { type: "apply-tool"; targetId: string }
  | { type: "toggle-trade-card"; cardInstanceId: string }
  | { type: "buy-offer"; offerId: string }
  | { type: "end-round" }
  | { type: "add-draft-stroke"; boardId: string; stroke: DraftStroke }
  | { type: "erase-draft-at"; boardId: string; x: number; y: number; radius: number }
  | { type: "clear-draft"; boardId: string }
  | { type: "resolve-board"; boardId: string; result: EvaluationResult };

import type { BoardMechanic, CellId, ClueAnchor, ClueInstance, ClueKind, DotColor } from "./types";

export type { ClueAnchor, DotColor, Side } from "./types";

export interface PlacedClue {
  id: string;
  clueKind: ClueKind | "vertex-dot";
  anchor: ClueAnchor;
  value?: number;
  color?: DotColor;
  sourceCardInstanceId?: string;
}

export interface BoardGeometry {
  rows: number;
  columns: number;
  activeCells: CellId[];
}

export interface LoopSegment {
  from: CellId;
  to: CellId;
}

export interface PuzzleSolutionLayers {
  shading?: Record<CellId, "black" | "white">;
  numbers?: Partial<Record<CellId, number>>;
  loop?: LoopSegment[];
  regions?: Partial<Record<CellId, string>>;
}

export interface PuzzleSnapshot {
  geometry: BoardGeometry;
  mechanic: BoardMechanic;
  clues: PlacedClue[];
  solution: PuzzleSolutionLayers;
}

export interface RuleExample {
  puzzle: PuzzleSnapshot;
  note: string;
  highlightedCells?: CellId[];
  highlightedEdges?: string[];
}

export function edgeId(anchor: Extract<ClueAnchor, { kind: "edge" }>) {
  return `${anchor.orientation}:${anchor.row}:${anchor.column}`;
}

export function anchorKindForClue(kind: ClueKind): ClueAnchor["kind"] {
  if (kind === "edge-number" || kind === "given-edge" || kind === "edge-white-dot" || kind === "edge-black-dot") return "edge";
  if (kind === "vertex-number" || kind === "vertex-white-dot" || kind === "vertex-black-dot") return "vertex";
  if (kind === "exterior-number") return "exterior";
  return "cell";
}

export function anchorKey(anchor: ClueAnchor) {
  if (anchor.kind === "cell") return `cell:${anchor.cell}`;
  if (anchor.kind === "edge") return `edge:${anchor.orientation}:${anchor.row}:${anchor.column}`;
  if (anchor.kind === "vertex") return `vertex:${anchor.row}:${anchor.column}`;
  return `exterior:${anchor.side}:${anchor.index}`;
}

export function cellsTouchedByAnchor(anchor: ClueAnchor): CellId[] {
  if (anchor.kind === "cell") return [anchor.cell];
  if (anchor.kind === "exterior") return [];
  if (anchor.kind === "edge") {
    return anchor.orientation === "vertical"
      ? [`${anchor.row}:${anchor.column - 1}`, `${anchor.row}:${anchor.column}`]
      : [`${anchor.row - 1}:${anchor.column}`, `${anchor.row}:${anchor.column}`] as CellId[];
  }
  return [
    `${anchor.row - 1}:${anchor.column - 1}`,
    `${anchor.row - 1}:${anchor.column}`,
    `${anchor.row}:${anchor.column - 1}`,
    `${anchor.row}:${anchor.column}`,
  ] as CellId[];
}

export function clueAnchorOf(clue: Pick<ClueInstance, "anchor" | "cellId" | "edgeId">): ClueAnchor | undefined {
  if (clue.anchor) return clue.anchor;
  if (clue.cellId) return { kind: "cell", cell: clue.cellId };
  if (clue.edgeId) {
    const [orientation, rawRow, rawColumn] = clue.edgeId.split(":");
    const row = Number(rawRow);
    const column = Number(rawColumn);
    if ((orientation === "horizontal" || orientation === "vertical") && Number.isInteger(row) && Number.isInteger(column)) {
      return { kind: "edge", orientation, row, column };
    }
  }
  return undefined;
}

/** Exterior clues observe the whole indexed row/column; removed cells create gaps but never stop observation. */
export function cellsObservedByExterior(geometry: BoardGeometry, anchor: Extract<ClueAnchor, { kind: "exterior" }>) {
  return exteriorLineSlots(geometry, anchor).filter((cell): cell is CellId => cell !== null);
}

/** Ordered from the clue side. Null slots preserve removed cells so they split consecutive segments. */
export function exteriorLineSlots(geometry: BoardGeometry, anchor: Extract<ClueAnchor, { kind: "exterior" }>): Array<CellId | null> {
  const active = new Set(geometry.activeCells);
  const horizontal = anchor.side === "left" || anchor.side === "right";
  const length = horizontal ? geometry.columns : geometry.rows;
  const reverse = anchor.side === "right" || anchor.side === "bottom";
  const indexes = Array.from({ length }, (_, index) => reverse ? length - index - 1 : index);
  return indexes.map((index) => {
    const cell = horizontal ? `${anchor.index}:${index}` as CellId : `${index}:${anchor.index}` as CellId;
    return active.has(cell) ? cell : null;
  });
}

export function validateInternalAnchor(geometry: BoardGeometry, anchor: ClueAnchor) {
  const active = new Set(geometry.activeCells);
  if (anchor.kind === "cell") return active.has(anchor.cell);
  if (anchor.kind === "exterior") {
    const limit = anchor.side === "left" || anchor.side === "right" ? geometry.rows : geometry.columns;
    return anchor.index >= 0 && anchor.index < limit;
  }
  return cellsTouchedByAnchor(anchor).every((cell) => active.has(cell));
}

/** Edge/vertex clues are fully internal, so any cell touching one is protected from removal. */
export function canRemoveCell(snapshot: Pick<PuzzleSnapshot, "geometry" | "clues">, target: CellId) {
  if (!snapshot.geometry.activeCells.includes(target)) return false;
  return snapshot.clues.every((clue) =>
    clue.anchor.kind === "cell" || clue.anchor.kind === "exterior" || !cellsTouchedByAnchor(clue.anchor).includes(target),
  );
}

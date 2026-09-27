import type { BoardState, CellId } from "./types";

type GridGeometry = Pick<BoardState, "rows" | "columns" | "activeCells">;

export function cellId(row: number, column: number): CellId {
  return `${row}:${column}`;
}

export function parseCellId(id: CellId) {
  const [row, column] = id.split(":").map(Number);
  return { row, column };
}

export function rectangularCells(rows: number, columns: number): CellId[] {
  return Array.from({ length: rows * columns }, (_, index) =>
    cellId(Math.floor(index / columns), index % columns),
  );
}

export function activeCellSet(board: GridGeometry) {
  return new Set<CellId>(board.activeCells);
}

export function orthogonalNeighbors(board: GridGeometry, id: CellId): CellId[] {
  const { row, column } = parseCellId(id);
  const active = activeCellSet(board);
  return [
    cellId(row - 1, column),
    cellId(row + 1, column),
    cellId(row, column - 1),
    cellId(row, column + 1),
  ].filter((candidate) => active.has(candidate));
}

export function diagonalNeighbors(board: GridGeometry, id: CellId): CellId[] {
  const { row, column } = parseCellId(id);
  const active = activeCellSet(board);
  return [
    cellId(row - 1, column - 1),
    cellId(row - 1, column + 1),
    cellId(row + 1, column - 1),
    cellId(row + 1, column + 1),
  ].filter((candidate) => active.has(candidate));
}

export function surroundingNeighbors(board: GridGeometry, id: CellId): CellId[] {
  return [...orthogonalNeighbors(board, id), ...diagonalNeighbors(board, id)];
}

/** Rays stop at the board boundary or the first removed cell. */
export function orthogonalRays(board: GridGeometry, id: CellId): CellId[][] {
  const { row, column } = parseCellId(id);
  const active = activeCellSet(board);
  return [[-1, 0], [1, 0], [0, -1], [0, 1]].map(([rowStep, columnStep]) => {
    const ray: CellId[] = [];
    let nextRow = row + rowStep;
    let nextColumn = column + columnStep;
    while (nextRow >= 0 && nextRow < board.rows && nextColumn >= 0 && nextColumn < board.columns) {
      const next = cellId(nextRow, nextColumn);
      if (!active.has(next)) break;
      ray.push(next);
      nextRow += rowStep;
      nextColumn += columnStep;
    }
    return ray;
  });
}

export function activeRowsAndColumns(board: GridGeometry): CellId[][] {
  const active = activeCellSet(board);
  const rows = Array.from({ length: board.rows }, (_, row) =>
    Array.from({ length: board.columns }, (_, column) => cellId(row, column)).filter((cell) => active.has(cell)),
  );
  const columns = Array.from({ length: board.columns }, (_, column) =>
    Array.from({ length: board.rows }, (_, row) => cellId(row, column)).filter((cell) => active.has(cell)),
  );
  return [...rows, ...columns];
}

/** Consecutive runs stop at removed cells; a missing cell is not an adjacency bridge. */
export function activeLineSegments(board: GridGeometry): CellId[][] {
  const active = activeCellSet(board);
  const segments: CellId[][] = [];
  const collect = (line: CellId[]) => {
    let segment: CellId[] = [];
    for (const cell of line) {
      if (active.has(cell)) segment.push(cell);
      else if (segment.length) {
        segments.push(segment);
        segment = [];
      }
    }
    if (segment.length) segments.push(segment);
  };
  for (let row = 0; row < board.rows; row += 1) {
    collect(Array.from({ length: board.columns }, (_, column) => cellId(row, column)));
  }
  for (let column = 0; column < board.columns; column += 1) {
    collect(Array.from({ length: board.rows }, (_, row) => cellId(row, column)));
  }
  return segments;
}

export function activeTwoByTwoBlocks(board: GridGeometry): CellId[][] {
  const active = activeCellSet(board);
  const blocks: CellId[][] = [];
  for (let row = 0; row < board.rows - 1; row += 1) {
    for (let column = 0; column < board.columns - 1; column += 1) {
      const block = [
        cellId(row, column),
        cellId(row, column + 1),
        cellId(row + 1, column),
        cellId(row + 1, column + 1),
      ];
      if (block.every((cell) => active.has(cell))) blocks.push(block);
    }
  }
  return blocks;
}

export function createBoard(id: string, name: string, size: number, ruleCapacity: number): BoardState {
  return {
    id,
    name,
    rows: size,
    columns: size,
    activeCells: rectangularCells(size, size),
    ruleCapacity,
    mechanic: null,
    globalCards: [],
    clueCards: [],
    clues: [],
    draftStrokes: [],
    revision: 0,
  };
}

export function refreshBoard(board: BoardState): BoardState {
  return {
    ...createBoard(board.id, board.name, board.rows, board.ruleCapacity),
    revision: board.revision + 1,
  };
}

import { orthogonalNeighbors } from "./geometry";
import { cellsTouchedByAnchor, clueAnchorOf, exteriorLineSlots } from "./puzzle-model";
import { clueCell, hasClueRule, hasGlobalRule, type CompiledPuzzle, type SolveOutcome } from "./solver-model";
import type { PuzzleSolutionLayers } from "./puzzle-model";
import type { CellId, ClueAnchor, ClueKind } from "./types";

type LabelMap = Map<CellId, number>;

export function solveRegion(model: CompiledPuzzle): SolveOutcome {
  const started = performance.now();
  const deadline = started + model.timeBudgetMs;
  const cells = [...model.board.activeCells].sort();
  const labels = new Int16Array(cells.length).fill(-1);
  const byCell = new Map(cells.map((cell, index) => [cell, index]));
  const solutions = new Set<string>();
  const solutionLayers: PuzzleSolutionLayers[] = [];
  let exploredNodes = 0;
  let timedOut = false;

  function partialValid(depth: number) {
    const partial = new Map<CellId, number>();
    for (let index = 0; index < depth; index += 1) partial.set(cells[index], labels[index]);
    for (const clue of model.board.clues) {
      const anchor = clueAnchorOf(clue);
      if (!anchor || anchor.kind !== "edge") continue;
      const touched = cellsTouchedByAnchor(anchor);
      if (!touched.every((cell) => partial.has(cell))) continue;
      const boundary = partial.get(touched[0]) !== partial.get(touched[1]);
      if (clue.kind === "given-edge" && hasClueRule(model, "region.given-edge.boundary", "given-edge") && !boundary) return false;
      const boundaryKinds = clueKindsForRule(model, "region.edge-dot.boundary");
      if (boundaryKinds.has(clue.kind) && !boundary) return false;
      if ((hasClueRule(model, "region.edge-number.area-sum", "edge-number")
        || hasClueRule(model, "region.edge-number.area-difference", "edge-number")
        || hasClueRule(model, "region.edge-number.boundary-length", "edge-number")) && clue.kind === "edge-number" && !boundary) return false;
    }
    if (hasGlobalRule(model, "region.exactly-one-cell-clue")) {
      const counts = new Map<number, number>();
      for (const clue of model.board.clues) {
        const cell = clueCell(clue);
        const label = cell ? partial.get(cell) : undefined;
        if (label === undefined) continue;
        counts.set(label, (counts.get(label) ?? 0) + 1);
        if (counts.get(label)! > 1) return false;
      }
    }
    if (hasClueRule(model, "region.cell-number.area", "cell-number")) {
      for (const clue of model.board.clues) {
        if (clue.kind !== "cell-number" || clue.value === undefined) continue;
        const cell = clueCell(clue);
        const label = cell ? partial.get(cell) : undefined;
        if (label === undefined) continue;
        if ([...partial.values()].filter((value) => value === label).length > clue.value) return false;
      }
    }
    return true;
  }

  function search(depth: number, maximumLabel: number) {
    exploredNodes += 1;
    if ((exploredNodes & 255) === 0 && performance.now() > deadline) {
      timedOut = true;
      return;
    }
    if (solutions.size >= model.solutionLimit) return;
    if (depth === cells.length) {
      const assignment = new Map(cells.map((cell, index) => [cell, labels[index]]));
      if (validateRegionPartition(model, assignment)) {
        const signature = [...labels].join(",");
        if (!solutions.has(signature)) {
          solutions.add(signature);
          solutionLayers.push({ regions: Object.fromEntries(cells.map((cell, index) => [cell, `R${labels[index]}`])) });
        }
      }
      return;
    }
    for (let label = 0; label <= maximumLabel + 1; label += 1) {
      labels[depth] = label;
      if (partialValid(depth + 1)) search(depth + 1, Math.max(maximumLabel, label));
      labels[depth] = -1;
      if (timedOut || solutions.size >= model.solutionLimit) return;
    }
  }

  if (cells.length) {
    labels[0] = 0;
    search(1, 0); // restricted-growth string: first cell is always region 0
  }
  return { count: solutions.size, timedOut, exploredNodes, elapsedMs: performance.now() - started, solutions: solutionLayers };
}

function clueKindsForRule(model: CompiledPuzzle, key: string) {
  return new Set<ClueKind>(model.clueRules.filter((rule) => rule.key === key).map((rule) => rule.clueKind));
}

export function validateRegionPartition(model: CompiledPuzzle, labels: LabelMap) {
  const { board } = model;
  if (board.activeCells.some((cell) => !labels.has(cell))) return false;
  const regions = new Map<number, Set<CellId>>();
  for (const cell of board.activeCells) {
    const label = labels.get(cell)!;
    if (!regions.has(label)) regions.set(label, new Set());
    regions.get(label)!.add(cell);
  }
  for (const region of regions.values()) if (!isConnected(board, region)) return false;

  if (hasGlobalRule(model, "region.rectangles") && [...regions.values()].some((region) => !isRectangle(region))) return false;
  if (hasGlobalRule(model, "region.center-symmetric") && [...regions.values()].some((region) => !isCentrallySymmetric(region))) return false;
  if (hasGlobalRule(model, "region.exactly-one-cell-clue")) {
    const counts = new Map<number, number>();
    for (const clue of board.clues) {
      const cell = clueCell(clue);
      if (!cell) continue;
      const label = labels.get(cell)!;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    if ([...regions.keys()].some((label) => counts.get(label) !== 1)) return false;
  }
  if (hasGlobalRule(model, "region.all-shapes-distinct")) {
    const shapes = [...regions.values()].map((region) => shapeKey(region, true, true));
    if (new Set(shapes).size !== shapes.length) return false;
  }

  const cellNumberSpecs = [
    { key: "region.cell-number.area", actual: (cell: CellId) => regions.get(labels.get(cell)!)!.size },
    { key: "region.cell-number.adjacent-boundary-count", actual: (cell: CellId) => cellBoundaryCount(board, labels, cell) },
    { key: "region.cell-number.neighboring-region-count", actual: (cell: CellId) => neighboringRegionCount(board, labels, labels.get(cell)!) },
    { key: "region.cell-number.perimeter", actual: (cell: CellId) => regionPerimeter(board, regions.get(labels.get(cell)!)!) },
  ] as const;
  for (const spec of cellNumberSpecs) {
    if (!hasClueRule(model, spec.key, "cell-number")) continue;
    for (const clue of board.clues) {
      if (clue.kind !== "cell-number" || clue.value === undefined) continue;
      const cell = clueCell(clue);
      if (!cell || spec.actual(cell) !== clue.value) return false;
    }
  }

  const edgeNumberSpecs = [
    { key: "region.edge-number.area-sum", actual: (left: Set<CellId>, right: Set<CellId>) => left.size + right.size },
    { key: "region.edge-number.area-difference", actual: (left: Set<CellId>, right: Set<CellId>) => Math.abs(left.size - right.size) },
  ] as const;
  for (const spec of edgeNumberSpecs) {
    if (!hasClueRule(model, spec.key, "edge-number")) continue;
    for (const clue of board.clues) {
      if (clue.kind !== "edge-number" || clue.value === undefined) continue;
      const anchor = clueAnchorOf(clue);
      if (!anchor || anchor.kind !== "edge") return false;
      const [first, second] = cellsTouchedByAnchor(anchor);
      const firstLabel = labels.get(first)!;
      const secondLabel = labels.get(second)!;
      if (firstLabel === secondLabel || spec.actual(regions.get(firstLabel)!, regions.get(secondLabel)!) !== clue.value) return false;
    }
  }
  if (hasClueRule(model, "region.edge-number.boundary-length", "edge-number")) {
    for (const clue of board.clues) {
      if (clue.kind !== "edge-number" || clue.value === undefined) continue;
      const anchor = clueAnchorOf(clue);
      if (!anchor || anchor.kind !== "edge" || boundaryLineLength(board, labels, anchor) !== clue.value) return false;
    }
  }

  const vertexNumberSpecs = [
    { key: "region.vertex-number.distinct-region-count", actual: (touched: CellId[]) => new Set(touched.map((cell) => labels.get(cell))).size },
    { key: "region.vertex-number.region-area-sum", actual: (touched: CellId[]) => [...new Set(touched.map((cell) => labels.get(cell)!))].reduce((sum, label) => sum + regions.get(label)!.size, 0) },
    { key: "region.vertex-number.distinct-shape-count", actual: (touched: CellId[]) => new Set([...new Set(touched.map((cell) => labels.get(cell)!))].map((label) => shapeKey(regions.get(label)!, true, true))).size },
  ] as const;
  for (const spec of vertexNumberSpecs) {
    if (!hasClueRule(model, spec.key, "vertex-number")) continue;
    for (const clue of board.clues) {
      if (clue.kind !== "vertex-number" || clue.value === undefined) continue;
      const anchor = clueAnchorOf(clue);
      if (!anchor || anchor.kind !== "vertex" || spec.actual(cellsTouchedByAnchor(anchor)) !== clue.value) return false;
    }
  }

  const centerCellKinds = clueKindsForRule(model, "region.cell-dot.center-symmetric-about-point");
  const axisCellKinds = clueKindsForRule(model, "region.cell-dot.axis-symmetric-through-point");
  const sameRotatedKinds = clueKindsForRule(model, "region.cell-dot.same-color-rotationally-congruent");
  const sameTranslatedKinds = clueKindsForRule(model, "region.cell-dot.same-color-translation-congruent");
  const sameNeighborKinds = clueKindsForRule(model, "region.cell-dot.orthogonal-neighborhood-same-region");
  const cellDots = board.clues.flatMap((clue) => {
    const cell = clueCell(clue);
    return cell && (clue.kind === "white-dot" || clue.kind === "black-dot") ? [{ cell, kind: clue.kind }] : [];
  });
  for (const clue of cellDots) {
    const region = regions.get(labels.get(clue.cell)!)!;
    const [row, column] = parseCell(clue.cell);
    if (sameNeighborKinds.has(clue.kind) && orthogonalNeighbors(board, clue.cell).some((cell) => labels.get(cell) !== labels.get(clue.cell))) return false;
    if (centerCellKinds.has(clue.kind) && !symmetricAbout(region, 2 * row + 1, 2 * column + 1, "center")) return false;
    if (axisCellKinds.has(clue.kind) && !hasAxisSymmetryAbout(region, 2 * row + 1, 2 * column + 1)) return false;
  }
  for (const [kinds, rotate] of [[sameRotatedKinds, true], [sameTranslatedKinds, false]] as const) {
    for (const kind of kinds) {
      const relevant = cellDots.filter((clue) => clue.kind === kind).map((clue) => regions.get(labels.get(clue.cell)!)!);
      if (relevant.length && relevant.some((region) => shapeKey(region, rotate, false) !== shapeKey(relevant[0], rotate, false))) return false;
    }
  }

  const boundaryKinds = clueKindsForRule(model, "region.edge-dot.boundary");
  const congruentKinds = clueKindsForRule(model, "region.edge-dot.rotationally-congruent-regions");
  const mirrorKinds = clueKindsForRule(model, "region.edge-dot.mirrored-regions");
  const edgeCenterKinds = clueKindsForRule(model, "region.edge-dot.center-symmetric-about-point");
  const edgeAxisKinds = clueKindsForRule(model, "region.edge-dot.axis-symmetric-through-point");
  for (const clue of board.clues) {
    const anchor = clueAnchorOf(clue);
    if (!anchor || anchor.kind !== "edge") continue;
    const [first, second] = cellsTouchedByAnchor(anchor);
    const firstLabel = labels.get(first)!;
    const secondLabel = labels.get(second)!;
    const boundary = firstLabel !== secondLabel;
    if (clue.kind === "given-edge" && hasClueRule(model, "region.given-edge.boundary", "given-edge") && !boundary) return false;
    if (boundaryKinds.has(clue.kind) && !boundary) return false;
    if (congruentKinds.has(clue.kind) && (!boundary || shapeKey(regions.get(firstLabel)!, true, false) !== shapeKey(regions.get(secondLabel)!, true, false))) return false;
    if (mirrorKinds.has(clue.kind) && (!boundary || !mirroredAcrossEdge(regions.get(firstLabel)!, regions.get(secondLabel)!, anchor))) return false;
    if (edgeCenterKinds.has(clue.kind) || edgeAxisKinds.has(clue.kind)) {
      if (boundary) return false;
      const [centerRow, centerColumn] = anchor.orientation === "vertical" ? [2 * anchor.row + 1, 2 * anchor.column] : [2 * anchor.row, 2 * anchor.column + 1];
      const region = regions.get(firstLabel)!;
      if (edgeCenterKinds.has(clue.kind) && !symmetricAbout(region, centerRow, centerColumn, "center")) return false;
      if (edgeAxisKinds.has(clue.kind) && !hasAxisSymmetryAbout(region, centerRow, centerColumn)) return false;
    }
  }

  const threeLineKinds = clueKindsForRule(model, "region.vertex-dot.three-lines");
  const fourLineKinds = clueKindsForRule(model, "region.vertex-dot.four-lines");
  const zeroLineKinds = clueKindsForRule(model, "region.vertex-dot.zero-lines");
  const vertexCenterKinds = clueKindsForRule(model, "region.vertex-dot.center-symmetric-about-point");
  const vertexAxisKinds = clueKindsForRule(model, "region.vertex-dot.axis-symmetric-through-point");
  for (const clue of board.clues) {
    const anchor = clueAnchorOf(clue);
    if (!anchor || anchor.kind !== "vertex") continue;
    const touched = cellsTouchedByAnchor(anchor);
    const lineCount = vertexLineCount(labels, touched);
    if (threeLineKinds.has(clue.kind) && lineCount !== 3) return false;
    if (fourLineKinds.has(clue.kind) && lineCount !== 4) return false;
    if (zeroLineKinds.has(clue.kind) && lineCount !== 0) return false;
    if (vertexCenterKinds.has(clue.kind) || vertexAxisKinds.has(clue.kind)) {
      if (new Set(touched.map((cell) => labels.get(cell))).size !== 1) return false;
      const region = regions.get(labels.get(touched[0])!)!;
      if (vertexCenterKinds.has(clue.kind) && !symmetricAbout(region, 2 * anchor.row, 2 * anchor.column, "center")) return false;
      if (vertexAxisKinds.has(clue.kind) && !hasAxisSymmetryAbout(region, 2 * anchor.row, 2 * anchor.column)) return false;
    }
  }

  const exteriorSpecs = [
    { key: "region.exterior-number.distinct-region-count", actual: (slots: Array<CellId | null>) => new Set(slots.filter((cell): cell is CellId => cell !== null).map((cell) => labels.get(cell))).size },
    { key: "region.exterior-number.longest-run", actual: (slots: Array<CellId | null>) => regionRuns(slots, labels).length ? Math.max(...regionRuns(slots, labels)) : undefined },
    { key: "region.exterior-number.shortest-run", actual: (slots: Array<CellId | null>) => regionRuns(slots, labels).length ? Math.min(...regionRuns(slots, labels)) : undefined },
  ] as const;
  for (const spec of exteriorSpecs) {
    if (!hasClueRule(model, spec.key, "exterior-number")) continue;
    for (const clue of board.clues) {
      if (clue.kind !== "exterior-number" || clue.value === undefined) continue;
      const anchor = clueAnchorOf(clue);
      if (!anchor || anchor.kind !== "exterior" || spec.actual(exteriorLineSlots(board, anchor)) !== clue.value) return false;
    }
  }
  return true;
}

function parseCell(cell: CellId) {
  return cell.split(":").map(Number) as [number, number];
}

function isConnected(board: CompiledPuzzle["board"], region: Set<CellId>) {
  const start = region.values().next().value as CellId | undefined;
  if (!start) return false;
  const reached = new Set<CellId>([start]);
  const queue = [start];
  while (queue.length) {
    const current = queue.shift()!;
    for (const neighbor of orthogonalNeighbors(board, current)) if (region.has(neighbor) && !reached.has(neighbor)) {
      reached.add(neighbor);
      queue.push(neighbor);
    }
  }
  return reached.size === region.size;
}

function isRectangle(region: Set<CellId>) {
  const points = [...region].map(parseCell);
  const rows = points.map(([row]) => row);
  const columns = points.map(([, column]) => column);
  return (Math.max(...rows) - Math.min(...rows) + 1) * (Math.max(...columns) - Math.min(...columns) + 1) === region.size;
}

function isCentrallySymmetric(region: Set<CellId>) {
  const points = [...region].map(parseCell);
  const rows = points.map(([row]) => row);
  const columns = points.map(([, column]) => column);
  const rowSum = Math.min(...rows) + Math.max(...rows);
  const columnSum = Math.min(...columns) + Math.max(...columns);
  return points.every(([row, column]) => region.has(`${rowSum - row}:${columnSum - column}` as CellId));
}

function normalizedPoints(region: Set<CellId>) {
  const points = [...region].map(parseCell);
  const minRow = Math.min(...points.map(([row]) => row));
  const minColumn = Math.min(...points.map(([, column]) => column));
  return points.map(([row, column]) => [row - minRow, column - minColumn] as [number, number]);
}

function shapeKey(region: Set<CellId>, rotate: boolean, reflect: boolean) {
  const points = normalizedPoints(region);
  const variants: string[] = [];
  const transformations = rotate ? [0, 1, 2, 3] : [0];
  for (const turns of transformations) for (const mirrored of reflect ? [false, true] : [false]) {
    let transformed = points.map(([row, column]) => [row, mirrored ? -column : column] as [number, number]);
    for (let turn = 0; turn < turns; turn += 1) transformed = transformed.map(([row, column]) => [column, -row]);
    const minRow = Math.min(...transformed.map(([row]) => row));
    const minColumn = Math.min(...transformed.map(([, column]) => column));
    variants.push(transformed.map(([row, column]) => `${row - minRow}:${column - minColumn}`).sort().join("|"));
  }
  return variants.sort()[0];
}

function cellBoundaryCount(board: CompiledPuzzle["board"], labels: LabelMap, cell: CellId) {
  const [row, column] = parseCell(cell);
  const neighbors = [[row - 1, column], [row + 1, column], [row, column - 1], [row, column + 1]];
  return neighbors.filter(([nextRow, nextColumn]) => labels.get(`${nextRow}:${nextColumn}` as CellId) !== labels.get(cell)).length;
}

function neighboringRegionCount(board: CompiledPuzzle["board"], labels: LabelMap, target: number) {
  const neighbors = new Set<number>();
  for (const cell of board.activeCells) {
    if (labels.get(cell) !== target) continue;
    for (const neighbor of orthogonalNeighbors(board, cell)) if (labels.get(neighbor) !== target) neighbors.add(labels.get(neighbor)!);
  }
  return neighbors.size;
}

function regionPerimeter(board: CompiledPuzzle["board"], region: Set<CellId>) {
  return [...region].reduce((sum, cell) => sum + cellBoundaryCount(board, new Map([...region].map((item) => [item, 1])), cell), 0);
}

function boundaryLineLength(board: CompiledPuzzle["board"], labels: LabelMap, anchor: Extract<ClueAnchor, { kind: "edge" }>) {
  const boundaryAt = (offset: number) => {
    const candidate = anchor.orientation === "vertical" ? { ...anchor, row: anchor.row + offset } : { ...anchor, column: anchor.column + offset };
    const touched = cellsTouchedByAnchor(candidate);
    return touched.every((cell) => labels.has(cell)) && labels.get(touched[0]) !== labels.get(touched[1]);
  };
  if (!boundaryAt(0)) return 0;
  let length = 1;
  for (const direction of [-1, 1]) for (let offset = direction; boundaryAt(offset); offset += direction) length += 1;
  return length;
}

function symmetricAbout(region: Set<CellId>, centerRow: number, centerColumn: number, type: "center" | "horizontal" | "vertical" | "diagonal" | "antidiagonal") {
  return [...region].every((cell) => {
    const [row, column] = parseCell(cell);
    const pointRow = 2 * row + 1;
    const pointColumn = 2 * column + 1;
    let nextRow = pointRow;
    let nextColumn = pointColumn;
    if (type === "center") [nextRow, nextColumn] = [2 * centerRow - pointRow, 2 * centerColumn - pointColumn];
    if (type === "horizontal") nextRow = 2 * centerRow - pointRow;
    if (type === "vertical") nextColumn = 2 * centerColumn - pointColumn;
    if (type === "diagonal") [nextRow, nextColumn] = [centerRow + pointColumn - centerColumn, centerColumn + pointRow - centerRow];
    if (type === "antidiagonal") [nextRow, nextColumn] = [centerRow - pointColumn + centerColumn, centerColumn - pointRow + centerRow];
    if (nextRow % 2 === 0 || nextColumn % 2 === 0) return false;
    return region.has(`${(nextRow - 1) / 2}:${(nextColumn - 1) / 2}` as CellId);
  });
}

function hasAxisSymmetryAbout(region: Set<CellId>, centerRow: number, centerColumn: number) {
  return (["horizontal", "vertical", "diagonal", "antidiagonal"] as const).some((axis) => symmetricAbout(region, centerRow, centerColumn, axis));
}

function mirroredAcrossEdge(first: Set<CellId>, second: Set<CellId>, anchor: Extract<ClueAnchor, { kind: "edge" }>) {
  const centerRow = anchor.orientation === "horizontal" ? 2 * anchor.row : 0;
  const centerColumn = anchor.orientation === "vertical" ? 2 * anchor.column : 0;
  const reflected = new Set([...first].map((cell) => {
    const [row, column] = parseCell(cell);
    return anchor.orientation === "vertical" ? `${row}:${centerColumn - column - 1}` : `${centerRow - row - 1}:${column}`;
  }));
  return reflected.size === second.size && [...reflected].every((cell) => second.has(cell as CellId));
}

function vertexLineCount(labels: LabelMap, touched: CellId[]) {
  const [topLeft, topRight, bottomLeft, bottomRight] = touched;
  return [
    labels.get(topLeft) !== labels.get(topRight),
    labels.get(bottomLeft) !== labels.get(bottomRight),
    labels.get(topLeft) !== labels.get(bottomLeft),
    labels.get(topRight) !== labels.get(bottomRight),
  ].filter(Boolean).length;
}

function regionRuns(slots: Array<CellId | null>, labels: LabelMap) {
  const runs: number[] = [];
  let previous: number | undefined;
  for (const cell of slots) {
    const label = cell === null ? undefined : labels.get(cell);
    if (label === undefined || label !== previous) {
      if (label !== undefined) runs.push(1);
    } else runs[runs.length - 1] += 1;
    previous = label;
  }
  return runs;
}

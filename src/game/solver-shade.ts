import {
  activeLineSegments,
  activeRowsAndColumns,
  activeTwoByTwoBlocks,
  cellId,
  diagonalNeighbors,
  orthogonalNeighbors,
  orthogonalRays,
  parseCellId,
  surroundingNeighbors,
} from "./geometry";
import { cellsObservedByExterior, cellsTouchedByAnchor, clueAnchorOf, exteriorLineSlots } from "./puzzle-model";
import { clueCell, hasClueRule, hasGlobalRule, type CompiledPuzzle, type SolveOutcome } from "./solver-model";
import type { CellId } from "./types";

export function solveShade(model: CompiledPuzzle): SolveOutcome {
  const started = performance.now();
  const deadline = started + model.timeBudgetMs;
  const { board, solutionLimit } = model;
  const stableCells = [...board.activeCells];
  const indexByCell = new Map(stableCells.map((cell, index) => [cell, index]));
  const assignments = new Int8Array(stableCells.length).fill(-1); // -1 未定，0 留白，1 涂黑
  const fixed = new Map<CellId, 0 | 1>();
  let initialConflict = false;

  function requireState(cell: CellId, state: 0 | 1) {
    if (!indexByCell.has(cell)) {
      initialConflict = true;
      return;
    }
    const existing = fixed.get(cell);
    if (existing !== undefined && existing !== state) initialConflict = true;
    fixed.set(cell, state);
  }

  if (hasClueRule(model, "shade.white-dot.unshaded", "white-dot")) {
    for (const clue of board.clues.filter((item) => item.kind === "white-dot")) {
      const cell = clueCell(clue);
      if (cell) requireState(cell, 0);
    }
  }
  if (hasClueRule(model, "shade.black-dot.shaded", "black-dot")) {
    for (const clue of board.clues.filter((item) => item.kind === "black-dot")) {
      const cell = clueCell(clue);
      if (cell) requireState(cell, 1);
    }
  }
  const cellDotClues = board.clues.flatMap((clue) => {
    const position = clueCell(clue);
    return (clue.kind === "white-dot" || clue.kind === "black-dot") && position
      ? [{ kind: clue.kind, position }]
      : [];
  });
  const clueKindsForRule = (key: string) => new Set(model.clueRules.filter((rule) => rule.key === key).map((rule) => rule.clueKind));
  const centerSymmetryKinds = clueKindsForRule("shade.cell-dot.component-center-symmetric");
  const axisSymmetryKinds = clueKindsForRule("shade.cell-dot.component-axis-symmetric");
  const oneWhiteNeighborKinds = clueKindsForRule("shade.cell-dot.exactly-one-white-neighbor");
  const centerSymmetryClues = cellDotClues.filter((clue) => centerSymmetryKinds.has(clue.kind));
  const axisSymmetryClues = cellDotClues.filter((clue) => axisSymmetryKinds.has(clue.kind));
  const clues: { target: number; cells: CellId[] }[] = [];
  const numberClues = board.clues.flatMap((clue) => {
    const position = clueCell(clue);
    return clue.kind === "cell-number" && position && clue.value !== undefined
      ? [{ position, target: clue.value }]
      : [];
  });
  const countRuleSpecs = [
    {
      key: "shade.cell-number.orthogonal-black",
      unshadedClue: true,
      cells: (position: CellId) => orthogonalNeighbors(board, position),
    },
    {
      key: "shade.cell-number.orthogonal-plus-self-black",
      unshadedClue: false,
      cells: (position: CellId) => [position, ...orthogonalNeighbors(board, position)],
    },
    {
      key: "shade.cell-number.surrounding-eight-black",
      unshadedClue: true,
      cells: (position: CellId) => surroundingNeighbors(board, position),
    },
    {
      key: "shade.cell-number.neighborhood-nine",
      unshadedClue: false,
      cells: (position: CellId) => [position, ...surroundingNeighbors(board, position)],
    },
  ];
  for (const rule of countRuleSpecs) {
    if (!hasClueRule(model, rule.key, "cell-number")) continue;
    for (const clue of numberClues) {
      if (rule.unshadedClue) requireState(clue.position, 0);
      clues.push({ target: clue.target, cells: rule.cells(clue.position) });
    }
  }
  for (const clue of cellDotClues.filter((item) => oneWhiteNeighborKinds.has(item.kind))) {
    const neighbors = orthogonalNeighbors(board, clue.position);
    clues.push({ target: neighbors.length - 1, cells: neighbors });
  }
  const anchoredCountRules = [
    { key: "shade.edge-number.black-count", clueKind: "edge-number", anchorKind: "edge" },
    { key: "shade.vertex-number.black-count", clueKind: "vertex-number", anchorKind: "vertex" },
    { key: "shade.exterior-number.black-count", clueKind: "exterior-number", anchorKind: "exterior" },
  ] as const;
  for (const rule of anchoredCountRules) {
    if (!hasClueRule(model, rule.key, rule.clueKind)) continue;
    for (const clue of board.clues) {
      if (clue.kind !== rule.clueKind || clue.value === undefined) continue;
      const anchor = clueAnchorOf(clue);
      if (!anchor || anchor.kind !== rule.anchorKind) {
        initialConflict = true;
        continue;
      }
      const observed = anchor.kind === "exterior"
        ? cellsObservedByExterior(board, anchor)
        : cellsTouchedByAnchor(anchor);
      if (observed.some((cell) => !indexByCell.has(cell))) {
        initialConflict = true;
        continue;
      }
      clues.push({ target: clue.value, cells: observed });
    }
  }
  const edgeComponentClues: { target: number; operation: "sum" | "difference"; cells: [CellId, CellId] }[] = [];
  const edgeComponentRules = [
    { key: "shade.edge-number.component-size-sum", operation: "sum" },
    { key: "shade.edge-number.component-size-difference", operation: "difference" },
  ] as const;
  for (const rule of edgeComponentRules) {
    if (!hasClueRule(model, rule.key, "edge-number")) continue;
    for (const clue of board.clues) {
      if (clue.kind !== "edge-number" || clue.value === undefined) continue;
      const anchor = clueAnchorOf(clue);
      if (!anchor || anchor.kind !== "edge") {
        initialConflict = true;
        continue;
      }
      const touched = cellsTouchedByAnchor(anchor);
      if (touched.length !== 2 || touched.some((cell) => !indexByCell.has(cell))) {
        initialConflict = true;
        continue;
      }
      const cells = touched as [CellId, CellId];
      clues.push({ target: 1, cells });
      edgeComponentClues.push({ target: clue.value, operation: rule.operation, cells });
    }
  }
  const landMeasurementClues: { target: number; cells: [CellId, CellId, CellId, CellId] }[] = [];
  if (hasClueRule(model, "shade.vertex-number.land-measurement", "vertex-number")) {
    for (const clue of board.clues) {
      if (clue.kind !== "vertex-number" || clue.value === undefined) continue;
      const anchor = clueAnchorOf(clue);
      if (!anchor || anchor.kind !== "vertex") {
        initialConflict = true;
        continue;
      }
      const touched = cellsTouchedByAnchor(anchor);
      if (touched.length !== 4 || touched.some((cell) => !indexByCell.has(cell))) {
        initialConflict = true;
        continue;
      }
      landMeasurementClues.push({ target: clue.value, cells: touched as [CellId, CellId, CellId, CellId] });
    }
  }
  const exteriorSegmentClues: {
    target: number;
    operation: "count" | "longest" | "first";
    slots: Array<CellId | null>;
  }[] = [];
  const exteriorSegmentRules = [
    { key: "shade.exterior-number.black-segment-count", operation: "count" },
    { key: "shade.exterior-number.longest-black-segment", operation: "longest" },
    { key: "shade.exterior-number.first-black-segment", operation: "first" },
  ] as const;
  for (const rule of exteriorSegmentRules) {
    if (!hasClueRule(model, rule.key, "exterior-number")) continue;
    for (const clue of board.clues) {
      if (clue.kind !== "exterior-number" || clue.value === undefined) continue;
      const anchor = clueAnchorOf(clue);
      if (!anchor || anchor.kind !== "exterior") {
        initialConflict = true;
        continue;
      }
      exteriorSegmentClues.push({ target: clue.value, operation: rule.operation, slots: exteriorLineSlots(board, anchor) });
    }
  }
  type EdgeDotKind = "edge-white-dot" | "edge-black-dot";
  type VertexDotKind = "vertex-white-dot" | "vertex-black-dot";
  const edgeDotKinds = new Set<EdgeDotKind>(["edge-white-dot", "edge-black-dot"]);
  const vertexDotKinds = new Set<VertexDotKind>(["vertex-white-dot", "vertex-black-dot"]);
  const edgeDotsForRule = (key: string) => {
    const activeKinds = clueKindsForRule(key);
    return board.clues.flatMap((clue) => {
      if (!edgeDotKinds.has(clue.kind as EdgeDotKind) || !activeKinds.has(clue.kind)) return [];
      const anchor = clueAnchorOf(clue);
      if (!anchor || anchor.kind !== "edge") {
        initialConflict = true;
        return [];
      }
      const cells = cellsTouchedByAnchor(anchor);
      if (cells.length !== 2 || cells.some((cell) => !indexByCell.has(cell))) {
        initialConflict = true;
        return [];
      }
      return [{ anchor, cells: cells as [CellId, CellId] }];
    });
  };
  const vertexDotsForRule = (key: string) => {
    const activeKinds = clueKindsForRule(key);
    return board.clues.flatMap((clue) => {
      if (!vertexDotKinds.has(clue.kind as VertexDotKind) || !activeKinds.has(clue.kind)) return [];
      const anchor = clueAnchorOf(clue);
      if (!anchor || anchor.kind !== "vertex") {
        initialConflict = true;
        return [];
      }
      const cells = cellsTouchedByAnchor(anchor);
      if (cells.length !== 4 || cells.some((cell) => !indexByCell.has(cell))) {
        initialConflict = true;
        return [];
      }
      return [{ cells: cells as [CellId, CellId, CellId, CellId] }];
    });
  };
  for (const clue of edgeDotsForRule("shade.edge-dot.both-white")) clues.push({ target: 0, cells: clue.cells });
  for (const clue of edgeDotsForRule("shade.edge-dot.exactly-one-black")) clues.push({ target: 1, cells: clue.cells });
  for (const clue of edgeDotsForRule("shade.edge-dot.both-black")) clues.push({ target: 2, cells: clue.cells });
  const congruentEdgeDotClues = edgeDotsForRule("shade.edge-dot.opposite-congruent-components");
  const mirroredEdgeDotClues = edgeDotsForRule("shade.edge-dot.opposite-mirrored-components");
  for (const clue of [...congruentEdgeDotClues, ...mirroredEdgeDotClues]) clues.push({ target: 1, cells: clue.cells });
  const vertexMajorityClues = [
    ...vertexDotsForRule("shade.vertex-dot.more-black-than-white").map((clue) => ({ ...clue, minimum: 3, maximum: 4 })),
    ...vertexDotsForRule("shade.vertex-dot.more-white-than-black").map((clue) => ({ ...clue, minimum: 0, maximum: 1 })),
  ];
  const vertexCheckerClues = vertexDotsForRule("shade.vertex-dot.checkerboard");
  const canalClues = hasClueRule(model, "shade.cell-number.canal-view", "cell-number")
    ? numberClues.map((clue) => ({ ...clue, rays: orthogonalRays(board, clue.position) }))
    : [];
  const kurodokoClues = hasClueRule(model, "shade.cell-number.kurodoko", "cell-number")
    ? numberClues.map((clue) => ({ ...clue, rays: orthogonalRays(board, clue.position) }))
    : [];
  const whiteComponentClues = hasClueRule(model, "shade.cell-number.white-component-size", "cell-number")
    ? numberClues
    : [];
  const kurottoClues = hasClueRule(model, "shade.cell-number.kurotto", "cell-number")
    ? numberClues
    : [];
  for (const clue of [...canalClues, ...kurodokoClues, ...whiteComponentClues, ...kurottoClues]) requireState(clue.position, 0);
  for (const [cell, state] of fixed) assignments[indexByCell.get(cell)!] = state;
  const incidence = new Map(stableCells.map((cell) => [cell, fixed.has(cell) ? 4 : 0]));
  for (const clue of clues) for (const cell of clue.cells) incidence.set(cell, (incidence.get(cell) ?? 0) + 1);
  for (const clue of edgeComponentClues) for (const cell of clue.cells) incidence.set(cell, (incidence.get(cell) ?? 0) + 2);
  for (const clue of landMeasurementClues) for (const cell of clue.cells) incidence.set(cell, (incidence.get(cell) ?? 0) + 2);
  for (const clue of exteriorSegmentClues) {
    for (const cell of clue.slots) if (cell) incidence.set(cell, (incidence.get(cell) ?? 0) + 1);
  }
  for (const clue of [...congruentEdgeDotClues, ...mirroredEdgeDotClues, ...vertexMajorityClues, ...vertexCheckerClues]) {
    for (const cell of clue.cells) incidence.set(cell, (incidence.get(cell) ?? 0) + 2);
  }
  for (const clue of [...centerSymmetryClues, ...axisSymmetryClues]) {
    incidence.set(clue.position, (incidence.get(clue.position) ?? 0) + 2);
  }
  for (const clue of canalClues) {
    for (const ray of clue.rays) for (const cell of ray) incidence.set(cell, (incidence.get(cell) ?? 0) + 1);
  }
  for (const clue of kurodokoClues) {
    for (const ray of clue.rays) for (const cell of ray) incidence.set(cell, (incidence.get(cell) ?? 0) + 1);
  }
  if (whiteComponentClues.length || kurottoClues.length) {
    for (const cell of stableCells) incidence.set(cell, (incidence.get(cell) ?? 0) + 1);
  }
  const connectedRule = hasGlobalRule(model, "shade.connected");
  const whiteConnectedRule = hasGlobalRule(model, "shade.white-connected");
  const noBlackTwoByTwoRule = hasGlobalRule(model, "shade.no-black-2x2");
  const noWhiteTwoByTwoRule = hasGlobalRule(model, "shade.no-white-2x2");
  const noRunThreeRule = hasGlobalRule(model, "shade.no-monochrome-run-3");
  const noRunFourRule = hasGlobalRule(model, "shade.no-monochrome-run-4");
  const equalLineCountsRule = hasGlobalRule(model, "shade.equal-row-column-counts");
  const noTouchRule = hasGlobalRule(model, "shade.black-cells-do-not-touch");
  const snakeRule = hasGlobalRule(model, "shade.single-snake");
  const twoByTwoBlocks = noBlackTwoByTwoRule || noWhiteTwoByTwoRule ? activeTwoByTwoBlocks(board) : [];
  const lines = equalLineCountsRule ? activeRowsAndColumns(board) : [];
  const lineSegments = noRunThreeRule || noRunFourRule ? activeLineSegments(board) : [];
  const monochromeWindows = [
    ...(noRunThreeRule ? lineSegments.flatMap((line) => windows(line, 3)) : []),
    ...(noRunFourRule ? lineSegments.flatMap((line) => windows(line, 4)) : []),
  ];
  for (const block of twoByTwoBlocks) for (const cell of block) incidence.set(cell, (incidence.get(cell) ?? 0) + 1);
  for (const window of monochromeWindows) for (const cell of window) incidence.set(cell, (incidence.get(cell) ?? 0) + 1);
  if (noTouchRule || snakeRule) {
    for (const cell of stableCells) incidence.set(cell, (incidence.get(cell) ?? 0) + surroundingNeighbors(board, cell).length);
  }
  const searchCells = [...stableCells].sort((left, right) => (incidence.get(right) ?? 0) - (incidence.get(left) ?? 0));
  const solutions = new Set<string>();
  let timedOut = false;
  let exploredNodes = 0;

  function assign(cell: CellId, value: 0 | 1, trail: number[]) {
    const index = indexByCell.get(cell)!;
    if (assignments[index] === value) return true;
    if (assignments[index] !== -1) return false;
    assignments[index] = value;
    trail.push(index);
    return true;
  }

  function colorCanStillConnect(color: 0 | 1, enabled: boolean) {
    if (!enabled) return true;
    const colored = stableCells.filter((cell) => assignments[indexByCell.get(cell)!] === color);
    if (colored.length < 2) return true;
    const reachable = new Set<CellId>([colored[0]]);
    const queue = [colored[0]];
    while (queue.length) {
      const current = queue.shift()!;
      for (const neighbor of orthogonalNeighbors(board, current)) {
        if (reachable.has(neighbor) || assignments[indexByCell.get(neighbor)!] === 1 - color) continue;
        reachable.add(neighbor);
        queue.push(neighbor);
      }
    }
    return colored.every((cell) => reachable.has(cell));
  }

  function forbidUniform(cells: CellId[], forbidden: 0 | 1, trail: number[]) {
    const undecided: CellId[] = [];
    for (const cell of cells) {
      const value = assignments[indexByCell.get(cell)!];
      if (value === 1 - forbidden) return true;
      if (value === -1) undecided.push(cell);
    }
    if (undecided.length === 0) return false;
    if (undecided.length === 1) return assign(undecided[0], (1 - forbidden) as 0 | 1, trail);
    return true;
  }

  function enforceEqualLineCounts(trail: number[]) {
    if (!equalLineCountsRule || lines.length === 0) return true;
    const ranges = lines.map((line) => {
      let black = 0;
      const undecided: CellId[] = [];
      for (const cell of line) {
        const value = assignments[indexByCell.get(cell)!];
        if (value === 1) black += 1;
        else if (value === -1) undecided.push(cell);
      }
      return { black, undecided, maximum: black + undecided.length };
    });
    const commonMinimum = Math.max(...ranges.map((range) => range.black));
    const commonMaximum = Math.min(...ranges.map((range) => range.maximum));
    if (commonMinimum > commonMaximum) return false;
    for (const range of ranges) {
      if (range.black === commonMaximum) {
        for (const cell of range.undecided) if (!assign(cell, 0, trail)) return false;
      } else if (range.maximum === commonMinimum) {
        for (const cell of range.undecided) if (!assign(cell, 1, trail)) return false;
      }
    }
    return true;
  }

  function enforceCanalView(trail: number[]) {
    for (const clue of canalClues) {
      const ranges = clue.rays.map((ray) => prefixRange(ray, 1));
      const minimum = ranges.reduce((sum, range) => sum + range.minimum, 0);
      const maximum = ranges.reduce((sum, range) => sum + range.maximum, 0);
      if (clue.target < minimum || clue.target > maximum) return false;
      if (clue.target === minimum) {
        for (const ray of clue.rays) {
          for (const cell of ray) {
            const value = assignments[indexByCell.get(cell)!];
            if (value === 1) continue;
            if (value === -1 && !assign(cell, 0, trail)) return false;
            break;
          }
        }
      }
      if (clue.target === maximum) {
        for (const ray of clue.rays) {
          for (const cell of ray) {
            const value = assignments[indexByCell.get(cell)!];
            if (value === 0) break;
            if (value === -1 && !assign(cell, 1, trail)) return false;
          }
        }
      }
    }
    return true;
  }

  function enforceKurodoko(trail: number[]) {
    for (const clue of kurodokoClues) {
      const ranges = clue.rays.map((ray) => prefixRange(ray, 0));
      const minimum = 1 + ranges.reduce((sum, range) => sum + range.minimum, 0);
      const maximum = 1 + ranges.reduce((sum, range) => sum + range.maximum, 0);
      if (clue.target < minimum || clue.target > maximum) return false;
      if (clue.target === minimum) {
        for (const ray of clue.rays) {
          for (const cell of ray) {
            const value = assignments[indexByCell.get(cell)!];
            if (value === 0) continue;
            if (value === -1 && !assign(cell, 1, trail)) return false;
            break;
          }
        }
      }
      if (clue.target === maximum) {
        for (const ray of clue.rays) {
          for (const cell of ray) {
            const value = assignments[indexByCell.get(cell)!];
            if (value === 1) break;
            if (value === -1 && !assign(cell, 0, trail)) return false;
          }
        }
      }
    }
    return true;
  }

  function enforceSnake(trail: number[]) {
    if (!snakeRule) return true;
    const black = stableCells.filter((cell) => assignments[indexByCell.get(cell)!] === 1);
    const undecided = stableCells.filter((cell) => assignments[indexByCell.get(cell)!] === -1);
    if (black.length + undecided.length < 2) return false;
    if (black.length + undecided.length === 2) {
      for (const cell of undecided) if (!assign(cell, 1, trail)) return false;
    }
    for (const cell of black) {
      for (const neighbor of diagonalNeighbors(board, cell)) {
        if (!assign(neighbor, 0, trail)) return false;
      }
      const neighbors = orthogonalNeighbors(board, cell);
      const blackDegree = neighbors.filter((neighbor) => assignments[indexByCell.get(neighbor)!] === 1).length;
      if (blackDegree > 2) return false;
      if (blackDegree === 2) {
        for (const neighbor of neighbors) {
          if (assignments[indexByCell.get(neighbor)!] === -1 && !assign(neighbor, 0, trail)) return false;
        }
      }
    }
    if (fixedBlackHasCycle(black)) return false;
    return colorCanStillConnect(1, true);
  }

  function fixedBlackHasCycle(black: CellId[]) {
    const blackSet = new Set(black);
    const seen = new Set<CellId>();
    for (const start of black) {
      if (seen.has(start)) continue;
      let vertices = 0;
      let degreeSum = 0;
      const queue = [start];
      seen.add(start);
      while (queue.length) {
        const current = queue.shift()!;
        vertices += 1;
        const neighbors = orthogonalNeighbors(board, current).filter((cell) => blackSet.has(cell));
        degreeSum += neighbors.length;
        for (const neighbor of neighbors) {
          if (seen.has(neighbor)) continue;
          seen.add(neighbor);
          queue.push(neighbor);
        }
      }
      if (degreeSum / 2 >= vertices) return true;
    }
    return false;
  }

  function enforceWhiteComponentSizes(trail: number[]) {
    for (const clue of whiteComponentClues) {
      const definite = reachableCells(clue.position, (cell) => assignments[indexByCell.get(cell)!] === 0);
      const possible = reachableCells(clue.position, (cell) => assignments[indexByCell.get(cell)!] !== 1);
      if (clue.target < definite.size || clue.target > possible.size) return false;
      if (clue.target === definite.size) {
        for (const cell of definite) {
          for (const neighbor of orthogonalNeighbors(board, cell)) {
            if (assignments[indexByCell.get(neighbor)!] === -1 && !assign(neighbor, 1, trail)) return false;
          }
        }
      }
      if (clue.target === possible.size) {
        for (const cell of possible) if (!assign(cell, 0, trail)) return false;
      }
    }
    return true;
  }

  function enforceKurotto(trail: number[]) {
    if (!kurottoClues.length) return true;
    const { components, componentByCell } = currentBlackComponents();
    for (const clue of kurottoClues) {
      const touchedIndexes = new Set<number>();
      for (const neighbor of surroundingNeighbors(board, clue.position)) {
        const componentIndex = componentByCell.get(neighbor);
        if (componentIndex !== undefined) touchedIndexes.add(componentIndex);
      }
      const minimum = [...touchedIndexes].reduce((sum, index) => sum + components[index].length, 0);
      const possible = possibleKurottoCells(clue.position);
      if (clue.target < minimum || clue.target > possible.size) return false;
      if (clue.target === minimum) {
        for (const index of touchedIndexes) {
          for (const cell of components[index]) {
            for (const neighbor of orthogonalNeighbors(board, cell)) {
              if (assignments[indexByCell.get(neighbor)!] === -1 && !assign(neighbor, 0, trail)) return false;
            }
          }
        }
        for (const neighbor of surroundingNeighbors(board, clue.position)) {
          if (assignments[indexByCell.get(neighbor)!] === -1 && !assign(neighbor, 0, trail)) return false;
        }
      }
      if (clue.target === possible.size) {
        for (const cell of possible) if (!assign(cell, 1, trail)) return false;
      }
    }
    return true;
  }

  function enforceEdgeComponentSizes() {
    for (const clue of edgeComponentClues) {
      const [left, right] = clue.cells;
      const leftValue = assignments[indexByCell.get(left)!];
      const rightValue = assignments[indexByCell.get(right)!];
      if (leftValue === -1 || rightValue === -1) continue;
      if (leftValue === rightValue) return false;
      const blackCell = leftValue === 1 ? left : right;
      const whiteCell = leftValue === 0 ? left : right;
      const blackRange = componentSizeRange(blackCell, 1);
      const whiteRange = componentSizeRange(whiteCell, 0);
      if (clue.operation === "sum") {
        if (clue.target < blackRange.minimum + whiteRange.minimum || clue.target > blackRange.maximum + whiteRange.maximum) return false;
      } else {
        const minimum = rangesAbsoluteDifferenceMinimum(blackRange, whiteRange);
        const maximum = Math.max(
          Math.abs(blackRange.minimum - whiteRange.maximum),
          Math.abs(blackRange.maximum - whiteRange.minimum),
        );
        if (clue.target < minimum || clue.target > maximum) return false;
      }
    }
    return true;
  }

  function enforceLandMeasurement(trail: number[]) {
    const complete = assignments.every((value) => value !== -1);
    for (const clue of landMeasurementClues) {
      const patterns = [
        [1, 0, 0, 1],
        [0, 1, 1, 0],
      ] as const;
      const possiblePatterns = patterns.filter((pattern) => clue.cells.every((cell, index) => {
        const value = assignments[indexByCell.get(cell)!];
        return value === -1 || value === pattern[index];
      }));
      if (!possiblePatterns.length) return false;
      if (possiblePatterns.length === 1) {
        for (let index = 0; index < clue.cells.length; index += 1) {
          if (!assign(clue.cells[index], possiblePatterns[0][index], trail)) return false;
        }
      }
      const pattern = possiblePatterns.length === 1 ? possiblePatterns[0] : undefined;
      if (!pattern) continue;
      const blackCells = clue.cells.filter((_, index) => pattern[index] === 1);
      const possibleDistance = shortestPathCellCount(blackCells[0], blackCells[1], (cell) => assignments[indexByCell.get(cell)!] !== 0);
      if (possibleDistance === null || possibleDistance > clue.target) return false;
      const fixedDistance = shortestPathCellCount(blackCells[0], blackCells[1], (cell) => assignments[indexByCell.get(cell)!] === 1);
      if (fixedDistance !== null && fixedDistance < clue.target) return false;
      if (complete && fixedDistance !== clue.target) return false;
    }
    return true;
  }

  function shortestPathCellCount(start: CellId, end: CellId, allowed: (cell: CellId) => boolean) {
    if (!allowed(start) || !allowed(end)) return null;
    const distance = new Map<CellId, number>([[start, 1]]);
    const queue = [start];
    while (queue.length) {
      const current = queue.shift()!;
      if (current === end) return distance.get(current)!;
      for (const neighbor of orthogonalNeighbors(board, current)) {
        if (!allowed(neighbor) || distance.has(neighbor)) continue;
        distance.set(neighbor, distance.get(current)! + 1);
        queue.push(neighbor);
      }
    }
    return null;
  }

  function enforceExteriorSegments() {
    for (const clue of exteriorSegmentClues) {
      const observed = clue.slots.filter((cell): cell is CellId => cell !== null);
      if (observed.some((cell) => assignments[indexByCell.get(cell)!] === -1)) continue;
      const runs: number[] = [];
      let current = 0;
      for (const cell of clue.slots) {
        if (cell && assignments[indexByCell.get(cell)!] === 1) current += 1;
        else if (current) {
          runs.push(current);
          current = 0;
        }
      }
      if (current) runs.push(current);
      const actual = clue.operation === "count"
        ? runs.length
        : clue.operation === "longest"
          ? Math.max(0, ...runs)
          : runs[0];
      if (actual === undefined || actual !== clue.target) return false;
    }
    return true;
  }

  function enforceCellDotSymmetry() {
    if (assignments.some((value) => value === -1)) return true;
    for (const clue of centerSymmetryClues) {
      const color = assignments[indexByCell.get(clue.position)!] as 0 | 1;
      const component = reachableCells(clue.position, (cell) => assignments[indexByCell.get(cell)!] === color);
      const center = parseCellId(clue.position);
      if (![...component].every((cell) => {
        const point = parseCellId(cell);
        return component.has(cellId(2 * center.row - point.row, 2 * center.column - point.column));
      })) return false;
    }
    for (const clue of axisSymmetryClues) {
      const color = assignments[indexByCell.get(clue.position)!] as 0 | 1;
      const component = reachableCells(clue.position, (cell) => assignments[indexByCell.get(cell)!] === color);
      const center = parseCellId(clue.position);
      const transforms = [
        (row: number, column: number) => cellId(row, 2 * center.column - column),
        (row: number, column: number) => cellId(2 * center.row - row, column),
        (row: number, column: number) => cellId(center.row + column - center.column, center.column + row - center.row),
        (row: number, column: number) => cellId(center.row - column + center.column, center.column - row + center.row),
      ];
      const hasAxis = transforms.some((transform) => [...component].every((cell) => {
        const point = parseCellId(cell);
        return component.has(transform(point.row, point.column));
      }));
      if (!hasAxis) return false;
    }
    return true;
  }

  function enforceAnchoredDots(trail: number[]) {
    for (const clue of vertexMajorityClues) {
      const black = clue.cells.filter((cell) => assignments[indexByCell.get(cell)!] === 1).length;
      const undecided = clue.cells.filter((cell) => assignments[indexByCell.get(cell)!] === -1);
      if (black > clue.maximum || black + undecided.length < clue.minimum) return false;
      if (black === clue.maximum) {
        for (const cell of undecided) if (!assign(cell, 0, trail)) return false;
      } else if (black + undecided.length === clue.minimum) {
        for (const cell of undecided) if (!assign(cell, 1, trail)) return false;
      }
    }
    for (const clue of vertexCheckerClues) {
      const patterns = [[1, 0, 0, 1], [0, 1, 1, 0]] as const;
      const possible = patterns.filter((pattern) => clue.cells.every((cell, index) => {
        const value = assignments[indexByCell.get(cell)!];
        return value === -1 || value === pattern[index];
      }));
      if (!possible.length) return false;
      if (possible.length === 1) {
        for (let index = 0; index < clue.cells.length; index += 1) {
          if (!assign(clue.cells[index], possible[0][index], trail)) return false;
        }
      }
    }
    if (assignments.some((value) => value === -1)) return true;
    for (const clue of congruentEdgeDotClues) {
      const [left, right] = clue.cells;
      const leftColor = assignments[indexByCell.get(left)!] as 0 | 1;
      const rightColor = assignments[indexByCell.get(right)!] as 0 | 1;
      if (leftColor === rightColor) return false;
      const leftComponent = reachableCells(left, (cell) => assignments[indexByCell.get(cell)!] === leftColor);
      const rightComponent = reachableCells(right, (cell) => assignments[indexByCell.get(cell)!] === rightColor);
      if (rotationCanonical(leftComponent) !== rotationCanonical(rightComponent)) return false;
    }
    for (const clue of mirroredEdgeDotClues) {
      const [left, right] = clue.cells;
      const leftColor = assignments[indexByCell.get(left)!] as 0 | 1;
      const rightColor = assignments[indexByCell.get(right)!] as 0 | 1;
      if (leftColor === rightColor) return false;
      const leftComponent = reachableCells(left, (cell) => assignments[indexByCell.get(cell)!] === leftColor);
      const rightComponent = reachableCells(right, (cell) => assignments[indexByCell.get(cell)!] === rightColor);
      const mirrored = new Set([...leftComponent].map((cell) => reflectAcrossEdge(cell, clue.anchor)));
      if (mirrored.size !== rightComponent.size || [...mirrored].some((cell) => !rightComponent.has(cell))) return false;
    }
    return true;
  }

  function rotationCanonical(component: Set<CellId>) {
    let points = [...component].map((cell) => {
      const { row, column } = parseCellId(cell);
      return [row, column] as [number, number];
    });
    const variants: string[] = [];
    for (let turn = 0; turn < 4; turn += 1) {
      const minimumRow = Math.min(...points.map(([row]) => row));
      const minimumColumn = Math.min(...points.map(([, column]) => column));
      variants.push(points.map(([row, column]) => `${row - minimumRow}:${column - minimumColumn}`).sort().join("|"));
      points = points.map(([row, column]) => [column, -row]);
    }
    return variants.sort()[0];
  }

  function reflectAcrossEdge(cell: CellId, anchor: Extract<ReturnType<typeof clueAnchorOf>, { kind: "edge" }>) {
    const { row, column } = parseCellId(cell);
    return anchor.orientation === "vertical"
      ? cellId(row, 2 * anchor.column - 1 - column)
      : cellId(2 * anchor.row - 1 - row, column);
  }

  function componentSizeRange(start: CellId, color: 0 | 1) {
    return {
      minimum: reachableCells(start, (cell) => assignments[indexByCell.get(cell)!] === color).size,
      maximum: reachableCells(start, (cell) => assignments[indexByCell.get(cell)!] !== 1 - color).size,
    };
  }

  function rangesAbsoluteDifferenceMinimum(
    left: { minimum: number; maximum: number },
    right: { minimum: number; maximum: number },
  ) {
    if (left.maximum < right.minimum) return right.minimum - left.maximum;
    if (right.maximum < left.minimum) return left.minimum - right.maximum;
    return 0;
  }

  function currentBlackComponents() {
    const components: CellId[][] = [];
    const componentByCell = new Map<CellId, number>();
    for (const start of stableCells) {
      if (assignments[indexByCell.get(start)!] !== 1 || componentByCell.has(start)) continue;
      const index = components.length;
      const component: CellId[] = [];
      const queue = [start];
      componentByCell.set(start, index);
      while (queue.length) {
        const current = queue.shift()!;
        component.push(current);
        for (const neighbor of orthogonalNeighbors(board, current)) {
          if (assignments[indexByCell.get(neighbor)!] !== 1 || componentByCell.has(neighbor)) continue;
          componentByCell.set(neighbor, index);
          queue.push(neighbor);
        }
      }
      components.push(component);
    }
    return { components, componentByCell };
  }

  function possibleKurottoCells(position: CellId) {
    const possible = new Set<CellId>();
    const queue = surroundingNeighbors(board, position).filter((cell) => assignments[indexByCell.get(cell)!] !== 0);
    for (const cell of queue) possible.add(cell);
    while (queue.length) {
      const current = queue.shift()!;
      for (const neighbor of orthogonalNeighbors(board, current)) {
        if (assignments[indexByCell.get(neighbor)!] === 0 || possible.has(neighbor)) continue;
        possible.add(neighbor);
        queue.push(neighbor);
      }
    }
    return possible;
  }

  function prefixRange(ray: CellId[], counted: 0 | 1) {
    let minimum = 0;
    for (const cell of ray) {
      if (assignments[indexByCell.get(cell)!] !== counted) break;
      minimum += 1;
    }
    let maximum = 0;
    for (const cell of ray) {
      if (assignments[indexByCell.get(cell)!] === 1 - counted) break;
      maximum += 1;
    }
    return { minimum, maximum };
  }

  function reachableCells(start: CellId, allowed: (cell: CellId) => boolean) {
    if (!allowed(start)) return new Set<CellId>();
    const reachable = new Set<CellId>([start]);
    const queue = [start];
    while (queue.length) {
      const current = queue.shift()!;
      for (const neighbor of orthogonalNeighbors(board, current)) {
        if (reachable.has(neighbor) || !allowed(neighbor)) continue;
        reachable.add(neighbor);
        queue.push(neighbor);
      }
    }
    return reachable;
  }

  function propagate(trail: number[]) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const clue of clues) {
        let black = 0;
        const undecided: CellId[] = [];
        for (const cell of clue.cells) {
          const value = assignments[indexByCell.get(cell)!];
          if (value === 1) black += 1;
          else if (value === -1) undecided.push(cell);
        }
        if (black > clue.target || black + undecided.length < clue.target) return false;
        if (undecided.length && (black === clue.target || black + undecided.length === clue.target)) {
          const forced = black === clue.target ? 0 : 1;
          for (const cell of undecided) {
            const before = trail.length;
            if (!assign(cell, forced, trail)) return false;
            changed ||= trail.length > before;
          }
        }
      }
      if (noTouchRule) {
        for (const cell of stableCells) {
          if (assignments[indexByCell.get(cell)!] !== 1) continue;
          for (const neighbor of surroundingNeighbors(board, cell)) {
            const before = trail.length;
            if (!assign(neighbor, 0, trail)) return false;
            changed ||= trail.length > before;
          }
        }
      }
      for (const block of twoByTwoBlocks) {
        const before = trail.length;
        if (noBlackTwoByTwoRule && !forbidUniform(block, 1, trail)) return false;
        if (noWhiteTwoByTwoRule && !forbidUniform(block, 0, trail)) return false;
        changed ||= trail.length > before;
      }
      for (const window of monochromeWindows) {
        const before = trail.length;
        if (!forbidUniform(window, 1, trail) || !forbidUniform(window, 0, trail)) return false;
        changed ||= trail.length > before;
      }
      const beforeEqualCounts = trail.length;
      if (!enforceEqualLineCounts(trail)) return false;
      changed ||= trail.length > beforeEqualCounts;
      const beforeCanalView = trail.length;
      if (!enforceCanalView(trail)) return false;
      changed ||= trail.length > beforeCanalView;
      const beforeKurodoko = trail.length;
      if (!enforceKurodoko(trail)) return false;
      changed ||= trail.length > beforeKurodoko;
      const beforeComponentSizes = trail.length;
      if (!enforceWhiteComponentSizes(trail)) return false;
      changed ||= trail.length > beforeComponentSizes;
      const beforeKurotto = trail.length;
      if (!enforceKurotto(trail)) return false;
      changed ||= trail.length > beforeKurotto;
      if (!enforceEdgeComponentSizes()) return false;
      const beforeLandMeasurement = trail.length;
      if (!enforceLandMeasurement(trail)) return false;
      changed ||= trail.length > beforeLandMeasurement;
      if (!enforceExteriorSegments()) return false;
      if (!enforceCellDotSymmetry()) return false;
      const beforeAnchoredDots = trail.length;
      if (!enforceAnchoredDots(trail)) return false;
      changed ||= trail.length > beforeAnchoredDots;
      const beforeSnake = trail.length;
      if (!enforceSnake(trail)) return false;
      changed ||= trail.length > beforeSnake;
      if (!colorCanStillConnect(1, connectedRule || snakeRule) || !colorCanStillConnect(0, whiteConnectedRule)) return false;
    }
    return true;
  }

  function search() {
    exploredNodes += 1;
    if ((exploredNodes & 255) === 0 && performance.now() > deadline) {
      timedOut = true;
      return;
    }
    if (solutions.size >= solutionLimit) return;
    const trail: number[] = [];
    if (!propagate(trail)) {
      for (const index of trail) assignments[index] = -1;
      return;
    }
    const cell = searchCells.find((candidate) => assignments[indexByCell.get(candidate)!] === -1);
    if (!cell) {
      if (colorCanStillConnect(1, connectedRule || snakeRule) && colorCanStillConnect(0, whiteConnectedRule)) {
        solutions.add(stableCells.map((candidate) => assignments[indexByCell.get(candidate)!]).join(""));
      }
    } else {
      for (const value of [0, 1] as const) {
        const branchTrail: number[] = [];
        if (assign(cell, value, branchTrail)) search();
        for (const index of branchTrail) assignments[index] = -1;
        if (timedOut || solutions.size >= solutionLimit) break;
      }
    }
    for (const index of trail) assignments[index] = -1;
  }

  if (!initialConflict) search();
  return { count: solutions.size, timedOut, exploredNodes, elapsedMs: performance.now() - started };
}

function windows(cells: CellId[], length: number) {
  return cells.length < length
    ? []
    : Array.from({ length: cells.length - length + 1 }, (_, index) => cells.slice(index, index + length));
}

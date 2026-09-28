import { orthogonalNeighbors, surroundingNeighbors } from "./geometry";
import { cellsObservedByExterior, cellsTouchedByAnchor, clueAnchorOf } from "./puzzle-model";
import type { PuzzleSolutionLayers, LoopSegment } from "./puzzle-model";
import { clueCell, hasClueRule, hasGlobalRule, type CompiledPuzzle, type SolveOutcome } from "./solver-model";
import type { CellId } from "./types";
import { acceptLoopPilotCandidate, isLoopPilotCompatibleModel, loopOrientationMatches, validateLoopSolution } from "./loop-pilot-validator";

type LoopCellRequirement = "straight" | "turn";
type LoopCellState = 0 | 1 | 2; // 0 回路，1 普通未经过格，2 不参与回路/计数的线索格

function edgeKey(left: CellId, right: CellId) {
  return left < right ? `${left}-${right}` : `${right}-${left}`;
}

function findLoopSolutions(
  model: CompiledPuzzle,
  visited: Set<CellId>,
  requirements: Map<CellId, LoopCellRequirement>,
  validateCycle: (path: CellId[]) => boolean,
  limit: number,
  deadline: number,
): { signatures: string[]; timedOut: boolean; exploredNodes: number } {
  const { board } = model;
  const signatures = new Set<string>();
  let exploredNodes = 0;
  if (visited.size < 4) return { signatures: [], timedOut: false, exploredNodes };
  if ([...requirements.keys()].some((cell) => !visited.has(cell))) {
    return { signatures: [], timedOut: false, exploredNodes };
  }

  const neighborMap = new Map<CellId, CellId[]>();
  for (const cell of visited) {
    const neighbors = orthogonalNeighbors(board, cell).filter((neighbor) => visited.has(neighbor));
    if (neighbors.length < 2) return { signatures: [], timedOut: false, exploredNodes };
    neighborMap.set(cell, neighbors);
  }

  const start = [...visited].sort((left, right) => {
    const requirementDifference = Number(requirements.has(right)) - Number(requirements.has(left));
    return requirementDifference || neighborMap.get(left)!.length - neighborMap.get(right)!.length || left.localeCompare(right);
  })[0];
  const path: CellId[] = [start];
  const used = new Set<CellId>([start]);
  let timedOut = false;

  function walk(current: CellId) {
    exploredNodes += 1;
    if ((exploredNodes & 255) === 0 && performance.now() > deadline) {
      timedOut = true;
      return;
    }
    if (signatures.size >= limit) return;
    if (path.length === visited.size) {
      if (!neighborMap.get(current)!.includes(start)) return;
      const startRequirement = requirements.get(start);
      if (startRequirement && !loopOrientationMatches(start, current, path[1], startRequirement)) return;
      const currentRequirement = requirements.get(current);
      if (currentRequirement && !loopOrientationMatches(current, path[path.length - 2], start, currentRequirement)) return;
      if (!validateCycle(path)) return;
      const edges = path.map((cell, index) => edgeKey(cell, path[(index + 1) % path.length])).sort();
      signatures.add(edges.join("|"));
      return;
    }

    const candidates = neighborMap
      .get(current)!
      .filter((neighbor) => !used.has(neighbor))
      .sort((left, right) => neighborMap.get(left)!.length - neighborMap.get(right)!.length);
    for (const next of candidates) {
      const requirement = requirements.get(current);
      if (requirement && path.length > 1 && !loopOrientationMatches(current, path[path.length - 2], next, requirement)) continue;
      used.add(next);
      path.push(next);
      walk(next);
      path.pop();
      used.delete(next);
      if (timedOut || signatures.size >= limit) return;
    }
  }

  walk(start);
  return { signatures: [...signatures], timedOut, exploredNodes };
}

export function solveLoop(model: CompiledPuzzle): SolveOutcome {
  const started = performance.now();
  const deadline = started + model.timeBudgetMs;
  const { board, solutionLimit } = model;
  // The existing in-search validator remains useful as pruning for all 46
  // loop rules. The shared pure validator below is the final acceptance gate
  // immediately before every legacy candidate is added.
  const pilotCompatible = isLoopPilotCompatibleModel(model);
  const stableCells = [...board.activeCells];
  const searchCells = [...stableCells];
  const indexByCell = new Map(stableCells.map((cell, index) => [cell, index]));
  const assignments = new Int8Array(stableCells.length).fill(-1);
  const fixed = new Map<CellId, LoopCellState>();
  const requirements = new Map<CellId, LoopCellRequirement>();
  let initialConflict = false;

  function requireState(cell: CellId, state: LoopCellState) {
    if (!indexByCell.has(cell)) {
      initialConflict = true;
      return;
    }
    const existing = fixed.get(cell);
    if (existing !== undefined && existing !== state) initialConflict = true;
    fixed.set(cell, state);
  }

  const allNumberClues = board.clues.flatMap((clue) => {
    const cell = clueCell(clue);
    return clue.kind === "cell-number" && cell && clue.value !== undefined
      ? [{ cell, value: clue.value }]
      : [];
  });
  const numberRule = hasClueRule(model, "loop.cell-number.orthogonal-unvisited", "cell-number");
  const straightRule = hasClueRule(model, "loop.white-dot.straight", "white-dot");
  const turnRule = hasClueRule(model, "loop.black-dot.turn", "black-dot");
  const numberClues = numberRule ? allNumberClues : [];

  const blockingNumberKeys = [
    "loop.cell-number.orthogonal-unvisited",
    "loop.cell-number.eight-visited",
    "loop.cell-number.eight-turns",
    "loop.cell-number.eight-unvisited",
    "loop.cell-number.four-turns",
    "loop.cell-number.four-visited",
    "loop.cell-number.outward-segment-length-sum",
  ];
  if (blockingNumberKeys.some((key) => hasClueRule(model, key, "cell-number"))) {
    for (const clue of allNumberClues) requireState(clue.cell, 2);
  }
  const clueKindsForRule = (key: string) => new Set(model.clueRules.filter((rule) => rule.key === key).map((rule) => rule.clueKind));
  const cellDots = board.clues.flatMap((clue) => {
    const cell = clueCell(clue);
    return (clue.kind === "white-dot" || clue.kind === "black-dot") && cell ? [{ kind: clue.kind, cell }] : [];
  });
  const visitedDotKinds = clueKindsForRule("loop.cell-dot.visited");
  const unvisitedDotKinds = clueKindsForRule("loop.cell-dot.unvisited");
  const straightDotKinds = clueKindsForRule("loop.cell-dot.straight");
  const turnDotKinds = clueKindsForRule("loop.cell-dot.turn");
  const masyuWhiteKinds = clueKindsForRule("loop.cell-dot.masyu-white");
  const masyuBlackKinds = clueKindsForRule("loop.cell-dot.masyu-black");
  const pearlBlackKinds = clueKindsForRule("loop.cell-dot.pearl-black");
  const pearlWhiteKinds = clueKindsForRule("loop.cell-dot.pearl-white");
  const equalArmKinds = clueKindsForRule("loop.cell-dot.equal-arm-lengths");
  const unequalArmKinds = clueKindsForRule("loop.cell-dot.unequal-arm-lengths");
  const armDifferenceOneKinds = clueKindsForRule("loop.cell-dot.arm-length-difference-one");
  const unvisitedCenterSymmetryKinds = clueKindsForRule("loop.cell-dot.unvisited-component-center-symmetric");
  const unvisitedAxisSymmetryKinds = clueKindsForRule("loop.cell-dot.unvisited-component-axis-symmetric");
  for (const clue of cellDots) {
    if (visitedDotKinds.has(clue.kind)) requireState(clue.cell, 0);
    if (unvisitedDotKinds.has(clue.kind)) requireState(clue.cell, 2);
    if (straightDotKinds.has(clue.kind) || masyuWhiteKinds.has(clue.kind)) {
      requireState(clue.cell, 0);
      requirements.set(clue.cell, "straight");
    }
    if (turnDotKinds.has(clue.kind) || masyuBlackKinds.has(clue.kind)) {
      requireState(clue.cell, 0);
      const existing = requirements.get(clue.cell);
      if (existing && existing !== "turn") initialConflict = true;
      requirements.set(clue.cell, "turn");
    }
    if (
      pearlBlackKinds.has(clue.kind)
      || pearlWhiteKinds.has(clue.kind)
      || equalArmKinds.has(clue.kind)
      || unequalArmKinds.has(clue.kind)
      || armDifferenceOneKinds.has(clue.kind)
    ) requireState(clue.cell, 0);
    if (unvisitedCenterSymmetryKinds.has(clue.kind) || unvisitedAxisSymmetryKinds.has(clue.kind)) requireState(clue.cell, 2);
  }
  if (hasGlobalRule(model, "loop.visit-all-unclued-cells")) {
    const cellClues = new Set(board.clues.flatMap((clue) => {
      const anchor = clueAnchorOf(clue);
      return anchor?.kind === "cell" ? [anchor.cell] : [];
    }));
    for (const cell of stableCells) if (!cellClues.has(cell)) requireState(cell, 0);
  }
  if (straightRule) {
    for (const clue of board.clues.filter((item) => item.kind === "white-dot")) {
      const cell = clueCell(clue);
      if (!cell) continue;
      requireState(cell, 0);
      requirements.set(cell, "straight");
    }
  }
  if (turnRule) {
    for (const clue of board.clues.filter((item) => item.kind === "black-dot")) {
      const cell = clueCell(clue);
      if (!cell) continue;
      requireState(cell, 0);
      const existing = requirements.get(cell);
      if (existing && existing !== "turn") initialConflict = true;
      requirements.set(cell, "turn");
    }
  }
  const hasSeparationRule = hasGlobalRule(model, "loop.unvisited-not-adjacent");
  const clues = numberClues.map((clue) => ({
    target: clue.value,
    neighbors: orthogonalNeighbors(board, clue.cell),
  }));
  const binaryClues: { target: number; cells: CellId[]; counted: "visited" | "unvisited" }[] = [];
  const numberCountSpecs = [
    { key: "loop.cell-number.eight-visited", cells: (cell: CellId) => surroundingNeighbors(board, cell), counted: "visited" },
    { key: "loop.cell-number.eight-unvisited", cells: (cell: CellId) => surroundingNeighbors(board, cell), counted: "unvisited" },
    { key: "loop.cell-number.four-visited", cells: (cell: CellId) => orthogonalNeighbors(board, cell), counted: "visited" },
  ] as const;
  for (const spec of numberCountSpecs) {
    if (!hasClueRule(model, spec.key, "cell-number")) continue;
    for (const clue of allNumberClues) binaryClues.push({ target: clue.value, cells: spec.cells(clue.cell), counted: spec.counted });
  }
  const anchoredCountSpecs = [
    { key: "loop.edge-number.visited-cell-count", kind: "edge-number", anchorKind: "edge" },
    { key: "loop.vertex-number.visited-cell-count", kind: "vertex-number", anchorKind: "vertex" },
    { key: "loop.exterior-number.visited-cell-count", kind: "exterior-number", anchorKind: "exterior" },
  ] as const;
  for (const spec of anchoredCountSpecs) {
    if (!hasClueRule(model, spec.key, spec.kind)) continue;
    for (const clue of board.clues) {
      if (clue.kind !== spec.kind || clue.value === undefined) continue;
      const anchor = clueAnchorOf(clue);
      if (!anchor || anchor.kind !== spec.anchorKind) {
        initialConflict = true;
        continue;
      }
      const cells = anchor.kind === "exterior" ? cellsObservedByExterior(board, anchor) : cellsTouchedByAnchor(anchor);
      if (cells.some((cell) => !indexByCell.has(cell))) initialConflict = true;
      else binaryClues.push({ target: clue.value, cells, counted: "visited" });
    }
  }
  const edgeDotKinds = clueKindsForRule("loop.edge-dot.exactly-one-cell-visited");
  for (const clue of board.clues) {
    if (!edgeDotKinds.has(clue.kind)) continue;
    const anchor = clueAnchorOf(clue);
    if (!anchor || anchor.kind !== "edge") {
      initialConflict = true;
      continue;
    }
    binaryClues.push({ target: 1, cells: cellsTouchedByAnchor(anchor), counted: "visited" });
  }
  const vertexMajorityClues: { cells: CellId[]; minimum: number; maximum: number }[] = [];
  const moreVisitedKinds = clueKindsForRule("loop.vertex-dot.more-visited");
  const moreUnvisitedKinds = clueKindsForRule("loop.vertex-dot.more-unvisited");
  for (const clue of board.clues) {
    const minimum = moreVisitedKinds.has(clue.kind) ? 3 : moreUnvisitedKinds.has(clue.kind) ? 0 : undefined;
    if (minimum === undefined) continue;
    const anchor = clueAnchorOf(clue);
    if (!anchor || anchor.kind !== "vertex") {
      initialConflict = true;
      continue;
    }
    vertexMajorityClues.push({ cells: cellsTouchedByAnchor(anchor), minimum, maximum: minimum === 3 ? 4 : 1 });
  }
  const turnCountClues: { target: number; cells: CellId[] }[] = [];
  const turnCountSpecs = [
    { key: "loop.cell-number.eight-turns", kind: "cell-number", cells: (anchor: NonNullable<ReturnType<typeof clueAnchorOf>>) => anchor.kind === "cell" ? surroundingNeighbors(board, anchor.cell) : [] },
    { key: "loop.cell-number.four-turns", kind: "cell-number", cells: (anchor: NonNullable<ReturnType<typeof clueAnchorOf>>) => anchor.kind === "cell" ? orthogonalNeighbors(board, anchor.cell) : [] },
    { key: "loop.vertex-number.turn-count", kind: "vertex-number", cells: (anchor: NonNullable<ReturnType<typeof clueAnchorOf>>) => anchor.kind === "vertex" ? cellsTouchedByAnchor(anchor) : [] },
  ] as const;
  for (const spec of turnCountSpecs) {
    if (!hasClueRule(model, spec.key, spec.kind)) continue;
    for (const clue of board.clues) {
      if (clue.kind !== spec.kind || clue.value === undefined) continue;
      const anchor = clueAnchorOf(clue);
      if (!anchor) {
        initialConflict = true;
        continue;
      }
      turnCountClues.push({ target: clue.value, cells: spec.cells(anchor) });
    }
  }
  const vertexEdgeCountClues: { target: number; cells: [CellId, CellId, CellId, CellId] }[] = [];
  if (hasClueRule(model, "loop.vertex-number.used-edge-count", "vertex-number")) {
    for (const clue of board.clues) {
      if (clue.kind !== "vertex-number" || clue.value === undefined) continue;
      const anchor = clueAnchorOf(clue);
      if (!anchor || anchor.kind !== "vertex") {
        initialConflict = true;
        continue;
      }
      vertexEdgeCountClues.push({ target: clue.value, cells: cellsTouchedByAnchor(anchor) as [CellId, CellId, CellId, CellId] });
    }
  }
  const insideVertexCountClues: { target: number; cell: CellId }[] = [];
  if (hasClueRule(model, "loop.cell-number.inside-vertex-count", "cell-number")) {
    for (const clue of allNumberClues) insideVertexCountClues.push({ target: clue.value, cell: clue.cell });
  }
  const armLengthSumClues: { target: number; cell: CellId }[] = [];
  if (hasClueRule(model, "loop.cell-number.arm-length-sum", "cell-number")) {
    for (const clue of allNumberClues) {
      requireState(clue.cell, 0);
      armLengthSumClues.push({ target: clue.value, cell: clue.cell });
    }
  }
  const outwardCellLengthClues: { target: number; cell: CellId }[] = [];
  if (hasClueRule(model, "loop.cell-number.outward-segment-length-sum", "cell-number")) {
    for (const clue of allNumberClues) {
      requireState(clue.cell, 2);
      outwardCellLengthClues.push({ target: clue.value, cell: clue.cell });
    }
  }
  const cellArmRelationClues = [
    ...cellDots.filter((clue) => equalArmKinds.has(clue.kind)).map((clue) => ({ cell: clue.cell, relation: "equal" as const })),
    ...cellDots.filter((clue) => unequalArmKinds.has(clue.kind)).map((clue) => ({ cell: clue.cell, relation: "unequal" as const })),
    ...cellDots.filter((clue) => armDifferenceOneKinds.has(clue.kind)).map((clue) => ({ cell: clue.cell, relation: "difference-one" as const })),
  ];
  const localOrientationClues = [
    ...cellDots.filter((clue) => masyuWhiteKinds.has(clue.kind)).map((clue) => ({ cell: clue.cell, rule: "masyu-white" as const })),
    ...cellDots.filter((clue) => masyuBlackKinds.has(clue.kind)).map((clue) => ({ cell: clue.cell, rule: "masyu-black" as const })),
    ...cellDots.filter((clue) => pearlBlackKinds.has(clue.kind)).map((clue) => ({ cell: clue.cell, rule: "pearl-black" as const })),
    ...cellDots.filter((clue) => pearlWhiteKinds.has(clue.kind)).map((clue) => ({ cell: clue.cell, rule: "pearl-white" as const })),
  ];
  const unvisitedCenterSymmetryClues = cellDots.filter((clue) => unvisitedCenterSymmetryKinds.has(clue.kind));
  const unvisitedAxisSymmetryClues = cellDots.filter((clue) => unvisitedAxisSymmetryKinds.has(clue.kind));
  const edgeTraversalClues: { cells: [CellId, CellId]; traversed: boolean }[] = [];
  const sameOrientationKinds = clueKindsForRule("loop.edge-dot.same-cell-orientation");
  const oppositeOrientationKinds = clueKindsForRule("loop.edge-dot.opposite-cell-orientation");
  const edgeOrientationClues: { cells: [CellId, CellId]; same: boolean }[] = [];
  const traversedKinds = clueKindsForRule("loop.edge-dot.traversed");
  const notTraversedKinds = clueKindsForRule("loop.edge-dot.not-traversed");
  const midpointKinds = clueKindsForRule("loop.edge-dot.segment-midpoint");
  const splitDifferenceOneKinds = clueKindsForRule("loop.edge-dot.split-cell-count-difference-one");
  const splitRatioTwoKinds = clueKindsForRule("loop.edge-dot.split-cell-count-ratio-two");
  const edgeSplitClues: { cells: [CellId, CellId]; relation: "equal" | "difference-one" | "ratio-two" }[] = [];
  for (const clue of board.clues) {
    const anchor = clueAnchorOf(clue);
    if (!anchor || anchor.kind !== "edge") continue;
    const cells = cellsTouchedByAnchor(anchor) as [CellId, CellId];
    if (traversedKinds.has(clue.kind)) edgeTraversalClues.push({ cells, traversed: true });
    if (notTraversedKinds.has(clue.kind)) edgeTraversalClues.push({ cells, traversed: false });
    if (sameOrientationKinds.has(clue.kind)) edgeOrientationClues.push({ cells, same: true });
    if (oppositeOrientationKinds.has(clue.kind)) edgeOrientationClues.push({ cells, same: false });
    if (midpointKinds.has(clue.kind)) edgeSplitClues.push({ cells, relation: "equal" });
    if (splitDifferenceOneKinds.has(clue.kind)) edgeSplitClues.push({ cells, relation: "difference-one" });
    if (splitRatioTwoKinds.has(clue.kind)) edgeSplitClues.push({ cells, relation: "ratio-two" });
  }
  const edgeSegmentLengthClues: { cells: [CellId, CellId]; target: number }[] = [];
  if (hasClueRule(model, "loop.edge-number.segment-length", "edge-number")) {
    for (const clue of board.clues) {
      if (clue.kind !== "edge-number" || clue.value === undefined) continue;
      const anchor = clueAnchorOf(clue);
      if (!anchor || anchor.kind !== "edge") {
        initialConflict = true;
        continue;
      }
      edgeSegmentLengthClues.push({ cells: cellsTouchedByAnchor(anchor) as [CellId, CellId], target: clue.value });
    }
  }
  const edgeOutwardLengthClues: { cells: [CellId, CellId]; directions: [[number, number], [number, number]]; target: number }[] = [];
  if (hasClueRule(model, "loop.edge-number.outward-segment-length-sum", "edge-number")) {
    for (const clue of board.clues) {
      if (clue.kind !== "edge-number" || clue.value === undefined) continue;
      const anchor = clueAnchorOf(clue);
      if (!anchor || anchor.kind !== "edge") {
        initialConflict = true;
        continue;
      }
      edgeOutwardLengthClues.push({
        cells: cellsTouchedByAnchor(anchor) as [CellId, CellId],
        directions: anchor.orientation === "vertical" ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]],
        target: clue.value,
      });
    }
  }
  const exteriorSegmentClues: { anchor: Extract<NonNullable<ReturnType<typeof clueAnchorOf>>, { kind: "exterior" }>; target: number; measure: "count" | "longest" | "shortest" }[] = [];
  const exteriorSegmentSpecs = [
    { key: "loop.exterior-number.parallel-segment-count", measure: "count" },
    { key: "loop.exterior-number.longest-parallel-segment", measure: "longest" },
    { key: "loop.exterior-number.shortest-parallel-segment", measure: "shortest" },
  ] as const;
  for (const spec of exteriorSegmentSpecs) {
    if (!hasClueRule(model, spec.key, "exterior-number")) continue;
    for (const clue of board.clues) {
      if (clue.kind !== "exterior-number" || clue.value === undefined) continue;
      const anchor = clueAnchorOf(clue);
      if (!anchor || anchor.kind !== "exterior") {
        initialConflict = true;
        continue;
      }
      exteriorSegmentClues.push({ anchor, target: clue.value, measure: spec.measure });
    }
  }
  const insideVertexKinds = clueKindsForRule("loop.vertex-dot.inside");
  const outsideVertexKinds = clueKindsForRule("loop.vertex-dot.outside");
  const vertexInsideClues: { row: number; column: number; inside: boolean }[] = [];
  for (const clue of board.clues) {
    const anchor = clueAnchorOf(clue);
    if (!anchor || anchor.kind !== "vertex") continue;
    if (insideVertexKinds.has(clue.kind)) vertexInsideClues.push({ row: anchor.row, column: anchor.column, inside: true });
    if (outsideVertexKinds.has(clue.kind)) vertexInsideClues.push({ row: anchor.row, column: anchor.column, inside: false });
  }
  for (const [cell, state] of fixed) assignments[indexByCell.get(cell)!] = state;
  const incidence = new Map(stableCells.map((cell) => [cell, requirements.has(cell) ? 3 : 0]));
  for (const clue of clues) {
    for (const neighbor of clue.neighbors) incidence.set(neighbor, (incidence.get(neighbor) ?? 0) + 2);
  }
  for (const clue of [...binaryClues, ...vertexMajorityClues]) {
    for (const cell of clue.cells) incidence.set(cell, (incidence.get(cell) ?? 0) + 1);
  }
  for (const clue of [...turnCountClues, ...vertexEdgeCountClues, ...edgeTraversalClues, ...edgeOrientationClues, ...edgeSplitClues, ...edgeSegmentLengthClues, ...edgeOutwardLengthClues]) {
    for (const cell of clue.cells) incidence.set(cell, (incidence.get(cell) ?? 0) + 1);
  }
  for (const clue of [...armLengthSumClues, ...outwardCellLengthClues, ...cellArmRelationClues]) {
    incidence.set(clue.cell, (incidence.get(clue.cell) ?? 0) + 2);
  }
  searchCells.sort((left, right) => (incidence.get(right) ?? 0) - (incidence.get(left) ?? 0));

  const solutions = new Set<string>();
  const solutionLayers: PuzzleSolutionLayers[] = [];
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

  function propagate(trail: number[]) {
    let changed = true;
    while (changed) {
      changed = false;
      if (hasSeparationRule) {
        for (const cell of stableCells) {
          if (assignments[indexByCell.get(cell)!] !== 1) continue;
          for (const neighbor of orthogonalNeighbors(board, cell)) {
            if (assignments[indexByCell.get(neighbor)!] === 2) continue;
            const before = trail.length;
            if (!assign(neighbor, 0, trail)) return false;
            changed ||= trail.length > before;
          }
        }
      }
      for (const clue of clues) {
        let unvisited = 0;
        const undecided: CellId[] = [];
        for (const neighbor of clue.neighbors) {
          const value = assignments[indexByCell.get(neighbor)!];
          if (value === 1) unvisited += 1;
          else if (value === -1) undecided.push(neighbor);
        }
        if (unvisited > clue.target || unvisited + undecided.length < clue.target) return false;
        if (undecided.length && (unvisited === clue.target || unvisited + undecided.length === clue.target)) {
          const forced = unvisited === clue.target ? 0 : 1;
          for (const cell of undecided) {
            const before = trail.length;
            if (!assign(cell, forced, trail)) return false;
            changed ||= trail.length > before;
          }
        }
      }
      for (const clue of binaryClues) {
        let counted = 0;
        const undecided: CellId[] = [];
        for (const cell of clue.cells) {
          const value = assignments[indexByCell.get(cell)!];
          if ((clue.counted === "visited" && value === 0) || (clue.counted === "unvisited" && value > 0)) counted += 1;
          else if (value === -1) undecided.push(cell);
        }
        if (counted > clue.target || counted + undecided.length < clue.target) return false;
        if (undecided.length && (counted === clue.target || counted + undecided.length === clue.target)) {
          const shouldCount = counted + undecided.length === clue.target;
          const forced = clue.counted === "visited" ? (shouldCount ? 0 : 1) : (shouldCount ? 1 : 0);
          for (const cell of undecided) {
            const before = trail.length;
            if (!assign(cell, forced, trail)) return false;
            changed ||= trail.length > before;
          }
        }
      }
      for (const clue of vertexMajorityClues) {
        const visited = clue.cells.filter((cell) => assignments[indexByCell.get(cell)!] === 0).length;
        const undecided = clue.cells.filter((cell) => assignments[indexByCell.get(cell)!] === -1);
        if (visited > clue.maximum || visited + undecided.length < clue.minimum) return false;
        if (visited === clue.maximum) {
          for (const cell of undecided) {
            const before = trail.length;
            if (!assign(cell, 1, trail)) return false;
            changed ||= trail.length > before;
          }
        } else if (visited + undecided.length === clue.minimum) {
          for (const cell of undecided) {
            const before = trail.length;
            if (!assign(cell, 0, trail)) return false;
            changed ||= trail.length > before;
          }
        }
      }
    }
    return true;
  }

  function validateCycle(path: CellId[]) {
    const position = new Map(path.map((cell, index) => [cell, index]));
    const loopEdges = new Set(path.map((cell, index) => edgeKey(cell, path[(index + 1) % path.length])));
    const isTurn = (cell: CellId) => {
      const index = position.get(cell);
      if (index === undefined) return false;
      return loopOrientationMatches(
        cell,
        path[(index - 1 + path.length) % path.length],
        path[(index + 1) % path.length],
        "turn",
      );
    };
    const armLengths = (cell: CellId): [number, number] | undefined => {
      const index = position.get(cell);
      if (index === undefined) return undefined;
      const walk = (step: -1 | 1) => {
        for (let distance = 1; distance <= path.length; distance += 1) {
          const candidate = path[(index + step * distance + path.length * 2) % path.length];
          if (isTurn(candidate)) return distance;
        }
        return Number.POSITIVE_INFINITY;
      };
      return [walk(-1), walk(1)];
    };
    const edgeSideRuns = (cells: [CellId, CellId]): [number, number] | undefined => {
      const [left, right] = cells;
      const leftIndex = position.get(left);
      const rightIndex = position.get(right);
      if (leftIndex === undefined || rightIndex === undefined || !loopEdges.has(edgeKey(left, right))) return undefined;
      const sideRun = (startIndex: number, acrossIndex: number) => {
        const forward = (startIndex + 1) % path.length === acrossIndex;
        const step: -1 | 1 = forward ? -1 : 1;
        if (isTurn(path[startIndex])) return 0;
        for (let distance = 1; distance < path.length; distance += 1) {
          const candidate = path[(startIndex + step * distance + path.length * 2) % path.length];
          if (isTurn(candidate)) return distance;
        }
        return Number.POSITIVE_INFINITY;
      };
      return [sideRun(leftIndex, rightIndex), sideRun(rightIndex, leftIndex)];
    };
    const parallelSegmentLengths = (anchor: Extract<NonNullable<ReturnType<typeof clueAnchorOf>>, { kind: "exterior" }>) => {
      const horizontal = anchor.side === "left" || anchor.side === "right";
      const starts: number[] = [];
      for (let index = 0; index < path.length; index += 1) {
        const first = path[index].split(":").map(Number);
        const second = path[(index + 1) % path.length].split(":").map(Number);
        if (horizontal && first[0] === anchor.index && second[0] === anchor.index) starts.push(Math.min(first[1], second[1]));
        if (!horizontal && first[1] === anchor.index && second[1] === anchor.index) starts.push(Math.min(first[0], second[0]));
      }
      starts.sort((left, right) => left - right);
      const lengths: number[] = [];
      for (let index = 0; index < starts.length; index += 1) {
        const start = starts[index];
        if (!lengths.length || start !== starts[index - 1] + 1) lengths.push(1);
        else lengths[lengths.length - 1] += 1;
      }
      return lengths;
    };
    const outwardRunLength = (cell: CellId, rowStep: number, columnStep: number) => {
      let [row, column] = cell.split(":").map(Number);
      let length = 0;
      while (true) {
        const next = `${row + rowStep}:${column + columnStep}` as CellId;
        const current = `${row}:${column}` as CellId;
        if (!loopEdges.has(edgeKey(current, next))) return length;
        length += 1;
        row += rowStep;
        column += columnStep;
      }
    };
    for (const clue of armLengthSumClues) {
      const arms = armLengths(clue.cell);
      if (!arms || arms[0] + arms[1] !== clue.target) return false;
    }
    for (const clue of cellArmRelationClues) {
      const arms = armLengths(clue.cell);
      if (!arms) return false;
      if (clue.relation === "equal" && arms[0] !== arms[1]) return false;
      if (clue.relation === "unequal" && arms[0] === arms[1]) return false;
      if (clue.relation === "difference-one" && Math.abs(arms[0] - arms[1]) !== 1) return false;
    }
    for (const clue of outwardCellLengthClues) {
      const [clueRow, clueColumn] = clue.cell.split(":").map(Number);
      const actual = orthogonalNeighbors(board, clue.cell).reduce((sum, neighbor) => {
        const [row, column] = neighbor.split(":").map(Number);
        return sum + outwardRunLength(neighbor, row - clueRow, column - clueColumn);
      }, 0);
      if (actual !== clue.target) return false;
    }
    for (const clue of edgeSegmentLengthClues) {
      const sides = edgeSideRuns(clue.cells);
      if (!sides || sides[0] + 1 + sides[1] !== clue.target) return false;
    }
    for (const clue of edgeSplitClues) {
      const sides = edgeSideRuns(clue.cells);
      if (!sides) return false;
      const counts: [number, number] = [sides[0] + 1, sides[1] + 1];
      if (clue.relation === "equal" && counts[0] !== counts[1]) return false;
      if (clue.relation === "difference-one" && Math.abs(counts[0] - counts[1]) !== 1) return false;
      if (clue.relation === "ratio-two" && counts[0] !== 2 * counts[1] && counts[1] !== 2 * counts[0]) return false;
    }
    for (const clue of edgeOutwardLengthClues) {
      if (loopEdges.has(edgeKey(...clue.cells))) return false;
      const actual = clue.cells.reduce((sum, cell, index) => {
        const [rowStep, columnStep] = clue.directions[index];
        return sum + outwardRunLength(cell, rowStep, columnStep);
      }, 0);
      if (actual !== clue.target) return false;
    }
    for (const clue of exteriorSegmentClues) {
      const lengths = parallelSegmentLengths(clue.anchor);
      const actual = clue.measure === "count"
        ? lengths.length
        : clue.measure === "longest"
          ? (lengths.length ? Math.max(...lengths) : undefined)
          : (lengths.length ? Math.min(...lengths) : undefined);
      if (actual !== clue.target) return false;
    }
    for (const clue of turnCountClues) {
      const actual = clue.cells.filter((cell) => position.has(cell) && isTurn(cell)).length;
      if (actual !== clue.target) return false;
    }
    for (const clue of vertexEdgeCountClues) {
      const [topLeft, topRight, bottomLeft, bottomRight] = clue.cells;
      const adjacentEdges = [
        edgeKey(topLeft, topRight), edgeKey(bottomLeft, bottomRight),
        edgeKey(topLeft, bottomLeft), edgeKey(topRight, bottomRight),
      ];
      if (adjacentEdges.filter((edge) => loopEdges.has(edge)).length !== clue.target) return false;
    }
    for (const clue of localOrientationClues) {
      const index = position.get(clue.cell);
      if (index === undefined) return false;
      const before = path[(index - 1 + path.length) % path.length];
      const after = path[(index + 1) % path.length];
      if (clue.rule === "masyu-white" && (isTurn(clue.cell) || (!isTurn(before) && !isTurn(after)))) return false;
      if (clue.rule === "masyu-black" && (!isTurn(clue.cell) || isTurn(before) || isTurn(after))) return false;
      if (clue.rule === "pearl-black" && (!isTurn(before) || !isTurn(after))) return false;
      if (clue.rule === "pearl-white" && (isTurn(before) || isTurn(after))) return false;
    }
    for (const clue of edgeTraversalClues) {
      if (loopEdges.has(edgeKey(...clue.cells)) !== clue.traversed) return false;
    }
    for (const clue of edgeOrientationClues) {
      if (!clue.cells.every((cell) => position.has(cell))) return false;
      if ((isTurn(clue.cells[0]) === isTurn(clue.cells[1])) !== clue.same) return false;
    }
    for (const clue of vertexInsideClues) {
      if (pointInsideLoop(clue.row, clue.column, path) !== clue.inside) return false;
    }
    for (const clue of insideVertexCountClues) {
      const [row, column] = clue.cell.split(":").map(Number);
      const vertices = [[row, column], [row, column + 1], [row + 1, column], [row + 1, column + 1]];
      if (vertices.filter(([vertexRow, vertexColumn]) => pointInsideLoop(vertexRow, vertexColumn, path)).length !== clue.target) return false;
    }
    const visited = new Set(path);
    for (const clue of unvisitedCenterSymmetryClues) {
      const component = unvisitedComponent(clue.cell, visited);
      const [centerRow, centerColumn] = clue.cell.split(":").map(Number);
      if ([...component].some((cell) => {
        const [row, column] = cell.split(":").map(Number);
        return !component.has(`${2 * centerRow - row}:${2 * centerColumn - column}` as CellId);
      })) return false;
    }
    for (const clue of unvisitedAxisSymmetryClues) {
      const component = unvisitedComponent(clue.cell, visited);
      const [centerRow, centerColumn] = clue.cell.split(":").map(Number);
      const transforms = [
        (row: number, column: number) => `${row}:${2 * centerColumn - column}` as CellId,
        (row: number, column: number) => `${2 * centerRow - row}:${column}` as CellId,
        (row: number, column: number) => `${centerRow + column - centerColumn}:${centerColumn + row - centerRow}` as CellId,
        (row: number, column: number) => `${centerRow - column + centerColumn}:${centerColumn - row + centerRow}` as CellId,
      ];
      if (!transforms.some((transform) => [...component].every((cell) => {
        const [row, column] = cell.split(":").map(Number);
        return component.has(transform(row, column));
      }))) return false;
    }
    return true;
  }

  function unvisitedComponent(start: CellId, visited: Set<CellId>) {
    if (visited.has(start)) return new Set<CellId>();
    const component = new Set<CellId>([start]);
    const queue = [start];
    while (queue.length) {
      const current = queue.shift()!;
      for (const neighbor of orthogonalNeighbors(board, current)) {
        if (visited.has(neighbor) || component.has(neighbor)) continue;
        component.add(neighbor);
        queue.push(neighbor);
      }
    }
    return component;
  }

  function pointInsideLoop(row: number, column: number, path: CellId[]) {
    const pointX = column;
    const pointY = row;
    const polygon = path.map((cell) => {
      const [cellRow, cellColumn] = cell.split(":").map(Number);
      return { x: cellColumn + 0.5, y: cellRow + 0.5 };
    });
    let inside = false;
    for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
      const currentPoint = polygon[index];
      const previousPoint = polygon[previous];
      const intersects = (currentPoint.y > pointY) !== (previousPoint.y > pointY)
        && pointX < ((previousPoint.x - currentPoint.x) * (pointY - currentPoint.y)) / (previousPoint.y - currentPoint.y) + currentPoint.x;
      if (intersects) inside = !inside;
    }
    return inside;
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
      const visited = new Set(stableCells.filter((candidate) => assignments[indexByCell.get(candidate)!] === 0));
      const loops = findLoopSolutions(model, visited, requirements, validateCycle, solutionLimit - solutions.size, deadline);
      exploredNodes += loops.exploredNodes;
      timedOut ||= loops.timedOut;
      for (const signature of loops.signatures) {
        if (solutions.has(signature)) continue;
        const loop: LoopSegment[] = signature.split("|").map((part) => {
          const separator = part.indexOf("-");
          return { from: part.slice(0, separator) as import("./types").CellId, to: part.slice(separator + 1) as import("./types").CellId };
        });
        // The pure validator is the final acceptance authority for every
        // loop model. The existing validateCycle remains search pruning; this
        // gate prevents a future pruning/semantics drift from leaking a
        // candidate into the public solution layers. Pilot signatures retain
        // the explicit expected-signature check for benchmark evidence.
        const sharedValidation = validateLoopSolution(model, loop);
        if (!sharedValidation.valid) continue;
        if (pilotCompatible && !acceptLoopPilotCandidate(model, loop, signature)) continue;
        solutions.add(signature);
        solutionLayers.push({ loop });
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

  if (!initialConflict && hasGlobalRule(model, "loop.single-cycle")) search();
  return { count: solutions.size, timedOut, exploredNodes, elapsedMs: performance.now() - started, solutions: solutionLayers };
}

import { orthogonalNeighbors } from "./geometry";
import { cellsTouchedByAnchor, clueAnchorOf, exteriorLineSlots } from "./puzzle-model";
import { clueCell, hasClueRule, hasGlobalRule, type CompiledPuzzle, type SolveOutcome } from "./solver-model";
import type { CellId, ClueKind } from "./types";

type Value = number; // 0 表示留空，正数表示填入的数字
type Relation = { cells: CellId[]; check: (values: Value[]) => boolean };

function arithmeticResult(values: number[], target: number) {
  if (values.length === 0) return false;
  if (values.length === 1) return values[0] === target;
  if (values.length !== 2) return false;
  const [left, right] = values;
  return left + right === target
    || Math.abs(left - right) === target
    || left * right === target
    || (right !== 0 && left % right === 0 && left / right === target)
    || (left !== 0 && right % left === 0 && right / left === target);
}

function rotatedIncreasing(values: number[], clockwise: boolean) {
  const ordered = clockwise ? values : [values[0], values[3], values[2], values[1]];
  return ordered.some((_, start) => {
    const rotated = ordered.map((__, offset) => ordered[(start + offset) % ordered.length]);
    return rotated.every((value, index) => index === 0 || rotated[index - 1] < value);
  });
}

export function solveNumber(model: CompiledPuzzle): SolveOutcome {
  const started = performance.now();
  const deadline = started + model.timeBudgetMs;
  const { board, solutionLimit } = model;
  const cells = [...board.activeCells];
  const indexByCell = new Map(cells.map((cell, index) => [cell, index]));
  const side = Math.max(board.rows, board.columns);
  const fullLatin = hasGlobalRule(model, "number.latin-1-to-n-full");
  const minusOneLatin = hasGlobalRule(model, "number.latin-1-to-n-minus-one");
  const minusTwoLatin = hasGlobalRule(model, "number.latin-1-to-n-minus-two");
  const connectedDigits = hasGlobalRule(model, "number.digit-cells-connected-no-equal-adjacency");
  let maximum = side;
  let blankAllowed = !fullLatin;
  if (minusOneLatin) maximum = Math.min(maximum, Math.max(0, side - 1));
  if (minusTwoLatin) maximum = Math.min(maximum, Math.max(0, side - 2));

  const assignments = new Int16Array(cells.length).fill(-1);
  const domains = new Map<CellId, Set<number>>(cells.map((cell) => [
    cell,
    new Set(Array.from({ length: maximum + (blankAllowed ? 1 : 0) }, (_, index) => index + (blankAllowed ? 0 : 1))),
  ]));
  let initialConflict = false;
  const clueKindsForRule = (key: string) => new Set<ClueKind>(model.clueRules.filter((rule) => rule.key === key).map((rule) => rule.clueKind));
  const setDomain = (cell: CellId, allowed: (value: number) => boolean) => {
    const domain = domains.get(cell);
    if (!domain) {
      initialConflict = true;
      return;
    }
    for (const value of [...domain]) if (!allowed(value)) domain.delete(value);
    if (!domain.size) initialConflict = true;
  };

  if (hasClueRule(model, "number.cell-number.fixed", "cell-number")) {
    for (const clue of board.clues) {
      if (clue.kind !== "cell-number" || clue.value === undefined) continue;
      const cell = clueCell(clue);
      if (!cell) initialConflict = true;
      else setDomain(cell, (value) => value === clue.value);
    }
  }

  const cellDots = board.clues.flatMap((clue) => {
    const cell = clueCell(clue);
    return cell && (clue.kind === "white-dot" || clue.kind === "black-dot") ? [{ cell, kind: clue.kind }] : [];
  });
  const emptyKinds = clueKindsForRule("number.cell-dot.empty");
  const filledKinds = clueKindsForRule("number.cell-dot.filled");
  const oddKinds = clueKindsForRule("number.cell-dot.odd");
  const evenKinds = clueKindsForRule("number.cell-dot.even");
  for (const clue of cellDots) {
    if (emptyKinds.has(clue.kind)) setDomain(clue.cell, (value) => value === 0);
    if (filledKinds.has(clue.kind)) setDomain(clue.cell, (value) => value > 0);
    if (oddKinds.has(clue.kind)) setDomain(clue.cell, (value) => value > 0 && value % 2 === 1);
    if (evenKinds.has(clue.kind)) setDomain(clue.cell, (value) => value > 0 && value % 2 === 0);
  }

  const relations: Relation[] = [];
  const addRelation = (relationCells: CellId[], check: (values: Value[]) => boolean) => {
    if (relationCells.some((cell) => !indexByCell.has(cell))) initialConflict = true;
    else relations.push({ cells: relationCells, check });
  };
  const anchoredNumbers = (kind: "edge-number" | "vertex-number" | "exterior-number") => board.clues.filter((clue) => clue.kind === kind && clue.value !== undefined);

  const edgeNumberSpecs = [
    { key: "number.edge-number.sum", check: (values: number[], target: number) => values.length > 0 && values.reduce((sum, value) => sum + value, 0) === target },
    { key: "number.edge-number.difference", check: (values: number[], target: number) => values.length === 1 ? values[0] === target : values.length === 2 && Math.abs(values[0] - values[1]) === target },
    { key: "number.edge-number.product", check: (values: number[], target: number) => values.length > 0 && values.reduce((product, value) => product * value, 1) === target },
    { key: "number.edge-number.contains", check: (values: number[], target: number) => values.includes(target) },
    { key: "number.edge-number.arithmetic", check: arithmeticResult },
  ] as const;
  for (const spec of edgeNumberSpecs) {
    if (!hasClueRule(model, spec.key, "edge-number")) continue;
    for (const clue of anchoredNumbers("edge-number")) {
      const anchor = clueAnchorOf(clue);
      if (!anchor || anchor.kind !== "edge") {
        initialConflict = true;
        continue;
      }
      addRelation(cellsTouchedByAnchor(anchor), (values) => spec.check(values.filter((value) => value > 0), clue.value!));
    }
  }

  const vertexNumberSpecs = [
    { key: "number.vertex-number.sum", check: (values: number[], target: number) => values.length > 0 && values.reduce((sum, value) => sum + value, 0) === target },
    { key: "number.vertex-number.contains", check: (values: number[], target: number) => values.includes(target) },
  ] as const;
  for (const spec of vertexNumberSpecs) {
    if (!hasClueRule(model, spec.key, "vertex-number")) continue;
    for (const clue of anchoredNumbers("vertex-number")) {
      const anchor = clueAnchorOf(clue);
      if (!anchor || anchor.kind !== "vertex") {
        initialConflict = true;
        continue;
      }
      addRelation(cellsTouchedByAnchor(anchor), (values) => spec.check(values.filter((value) => value > 0), clue.value!));
    }
  }
  const diagonalSpecs = [
    { key: "number.vertex-number.diagonal-sums", check: (values: number[], target: number) => values.length > 0 && values.reduce((sum, value) => sum + value, 0) === target },
    { key: "number.vertex-number.diagonal-differences", check: (values: number[], target: number) => values.length === 1 ? values[0] === target : values.length === 2 && Math.abs(values[0] - values[1]) === target },
    { key: "number.vertex-number.diagonal-arithmetic", check: arithmeticResult },
  ] as const;
  for (const spec of diagonalSpecs) {
    if (!hasClueRule(model, spec.key, "vertex-number")) continue;
    for (const clue of anchoredNumbers("vertex-number")) {
      const anchor = clueAnchorOf(clue);
      if (!anchor || anchor.kind !== "vertex") {
        initialConflict = true;
        continue;
      }
      const touched = cellsTouchedByAnchor(anchor);
      addRelation(touched, (values) => {
        const first = [values[0], values[3]].filter((value) => value > 0);
        const second = [values[1], values[2]].filter((value) => value > 0);
        return spec.check(first, clue.value!) && spec.check(second, clue.value!);
      });
    }
  }

  const sameColorKinds = clueKindsForRule("number.cell-dot.same-color-equal");
  for (const kind of sameColorKinds) {
    const matching = cellDots.filter((clue) => clue.kind === kind).map((clue) => clue.cell);
    if (matching.length) addRelation(matching, (values) => values.every((value) => value > 0 && value === values[0]));
  }
  const greaterKinds = clueKindsForRule("number.cell-dot.greater-than-neighbors");
  const lessKinds = clueKindsForRule("number.cell-dot.less-than-neighbors");
  for (const clue of cellDots) {
    const relation = greaterKinds.has(clue.kind) ? "greater" : lessKinds.has(clue.kind) ? "less" : undefined;
    if (!relation) continue;
    const neighbors = orthogonalNeighbors(board, clue.cell);
    addRelation([clue.cell, ...neighbors], (values) => values[0] > 0 && values.slice(1).filter((value) => value > 0).every((value) => relation === "greater" ? values[0] > value : values[0] < value));
  }

  const edgeDotSpecs = [
    { key: "number.edge-dot.both-filled", check: (values: number[]) => values.every((value) => value > 0) },
    { key: "number.edge-dot.exactly-one-filled", check: (values: number[]) => values.filter((value) => value > 0).length === 1 },
    { key: "number.edge-dot.both-empty", check: (values: number[]) => values.every((value) => value === 0) },
    { key: "number.edge-dot.difference-one", check: (values: number[]) => values.every((value) => value > 0) && Math.abs(values[0] - values[1]) === 1 },
    { key: "number.edge-dot.ratio-two", check: (values: number[]) => values.every((value) => value > 0) && (values[0] === 2 * values[1] || values[1] === 2 * values[0]) },
    { key: "number.edge-dot.sum-five", check: (values: number[]) => values.every((value) => value > 0) && values[0] + values[1] === 5 },
    { key: "number.edge-dot.sum-ten", check: (values: number[]) => values.every((value) => value > 0) && values[0] + values[1] === 10 },
  ] as const;
  for (const spec of edgeDotSpecs) {
    const kinds = clueKindsForRule(spec.key);
    if (!kinds.size) continue;
    for (const clue of board.clues) {
      if (!kinds.has(clue.kind)) continue;
      const anchor = clueAnchorOf(clue);
      if (!anchor || anchor.kind !== "edge") initialConflict = true;
      else addRelation(cellsTouchedByAnchor(anchor), spec.check);
    }
  }
  const sameSumKinds = clueKindsForRule("number.edge-dot.same-color-equal-sums");
  for (const kind of sameSumKinds) {
    const groups = board.clues.flatMap((clue) => {
      if (clue.kind !== kind) return [];
      const anchor = clueAnchorOf(clue);
      return anchor?.kind === "edge" ? [cellsTouchedByAnchor(anchor)] : [];
    });
    const flattened = groups.flat();
    if (groups.length) addRelation(flattened, (values) => {
      const sums = groups.map((group, groupIndex) => values.slice(groupIndex * group.length, (groupIndex + 1) * group.length));
      return sums.every((group) => group.every((value) => value > 0)) && sums.every((group) => group[0] + group[1] === sums[0][0] + sums[0][1]);
    });
  }

  const vertexDotSpecs = [
    { key: "number.vertex-dot.more-even", check: (values: number[]) => values.filter((value) => value > 0 && value % 2 === 0).length > values.filter((value) => value % 2 === 1).length },
    { key: "number.vertex-dot.more-odd", check: (values: number[]) => values.filter((value) => value % 2 === 1).length > values.filter((value) => value > 0 && value % 2 === 0).length },
    { key: "number.vertex-dot.more-empty", check: (values: number[]) => values.filter((value) => value === 0).length > values.filter((value) => value > 0).length },
    { key: "number.vertex-dot.more-filled", check: (values: number[]) => values.filter((value) => value > 0).length > values.filter((value) => value === 0).length },
    { key: "number.vertex-dot.clockwise-increasing", check: (values: number[]) => values.every((value) => value > 0) && rotatedIncreasing([values[0], values[1], values[3], values[2]], true) },
    { key: "number.vertex-dot.counterclockwise-increasing", check: (values: number[]) => values.every((value) => value > 0) && rotatedIncreasing([values[0], values[1], values[3], values[2]], false) },
    { key: "number.vertex-dot.exactly-one-consecutive-pair", check: (values: number[]) => values.every((value) => value > 0) && pairDifferences(values) === 1 },
    { key: "number.vertex-dot.at-least-two-consecutive-pairs", check: (values: number[]) => values.every((value) => value > 0) && pairDifferences(values) >= 2 },
  ] as const;
  for (const spec of vertexDotSpecs) {
    const kinds = clueKindsForRule(spec.key);
    if (!kinds.size) continue;
    for (const clue of board.clues) {
      if (!kinds.has(clue.kind)) continue;
      const anchor = clueAnchorOf(clue);
      if (!anchor || anchor.kind !== "vertex") initialConflict = true;
      else addRelation(cellsTouchedByAnchor(anchor), spec.check);
    }
  }

  const exteriorSpecs = [
    { key: "number.exterior-number.first-number", check: (values: number[], target: number) => values.find((value) => value > 0) === target },
    { key: "number.exterior-number.skyscraper-count", check: (values: number[], target: number) => visible(values).length === target },
    { key: "number.exterior-number.skyscraper-sum", check: (values: number[], target: number) => visible(values).reduce((sum, value) => sum + value, 0) === target },
    { key: "number.exterior-number.first-two-contain", check: (values: number[], target: number) => values.slice(0, 2).includes(target) },
  ] as const;
  for (const spec of exteriorSpecs) {
    if (!hasClueRule(model, spec.key, "exterior-number")) continue;
    for (const clue of anchoredNumbers("exterior-number")) {
      const anchor = clueAnchorOf(clue);
      if (!anchor || anchor.kind !== "exterior") {
        initialConflict = true;
        continue;
      }
      const observed = exteriorLineSlots(board, anchor).filter((cell): cell is CellId => cell !== null);
      addRelation(observed, (values) => spec.check(values, clue.value!));
    }
  }

  const rows = Array.from({ length: board.rows }, (_, row) => cells.filter((cell) => Number(cell.split(":")[0]) === row));
  const columns = Array.from({ length: board.columns }, (_, column) => cells.filter((cell) => Number(cell.split(":")[1]) === column));
  const latinLines = [...rows, ...columns];
  const requiredMaxima = [minusOneLatin ? side - 1 : 0, minusTwoLatin ? side - 2 : 0].filter((value) => value > 0);
  const incidence = new Map(cells.map((cell) => [cell, 0]));
  for (const relation of relations) for (const cell of relation.cells) incidence.set(cell, (incidence.get(cell) ?? 0) + 1);
  const ordered = [...cells].sort((left, right) => domains.get(left)!.size - domains.get(right)!.size || (incidence.get(right) ?? 0) - (incidence.get(left) ?? 0));
  const solutions = new Set<string>();
  let exploredNodes = 0;
  let timedOut = false;

  function partialValid() {
    if (fullLatin || minusOneLatin || minusTwoLatin) {
      for (const line of latinLines) {
        const assigned = line.map((cell) => assignments[indexByCell.get(cell)!]).filter((value) => value > 0);
        if (new Set(assigned).size !== assigned.length) return false;
        for (const requireAll of requiredMaxima) {
          const undecided = line.filter((cell) => assignments[indexByCell.get(cell)!] === -1);
          for (let value = 1; value <= requireAll; value += 1) {
            if (!assigned.includes(value) && !undecided.some((cell) => domains.get(cell)!.has(value))) return false;
          }
        }
      }
    }
    if (connectedDigits) {
      for (const cell of cells) {
        const value = assignments[indexByCell.get(cell)!];
        if (value <= 0) continue;
        if (orthogonalNeighbors(board, cell).some((neighbor) => assignments[indexByCell.get(neighbor)!] === value)) return false;
      }
    }
    for (const relation of relations) {
      const values = relation.cells.map((cell) => assignments[indexByCell.get(cell)!]);
      if (values.every((value) => value !== -1) && !relation.check(values)) return false;
    }
    return true;
  }

  function finalValid() {
    for (const requireAll of requiredMaxima) {
      for (const line of latinLines) for (let value = 1; value <= requireAll; value += 1) {
        if (!line.some((cell) => assignments[indexByCell.get(cell)!] === value)) return false;
      }
    }
    if (connectedDigits) {
      const digitCells = cells.filter((cell) => assignments[indexByCell.get(cell)!] > 0);
      if (!digitCells.length) return false;
      const reached = new Set<CellId>([digitCells[0]]);
      const queue = [digitCells[0]];
      while (queue.length) {
        const current = queue.shift()!;
        for (const neighbor of orthogonalNeighbors(board, current)) {
          if (assignments[indexByCell.get(neighbor)!] <= 0 || reached.has(neighbor)) continue;
          reached.add(neighbor);
          queue.push(neighbor);
        }
      }
      if (reached.size !== digitCells.length) return false;
    }
    return true;
  }

  function search(depth: number) {
    exploredNodes += 1;
    if ((exploredNodes & 255) === 0 && performance.now() > deadline) {
      timedOut = true;
      return;
    }
    if (solutions.size >= solutionLimit) return;
    if (depth === ordered.length) {
      if (finalValid()) solutions.add([...assignments].join(","));
      return;
    }
    const cell = ordered[depth];
    const index = indexByCell.get(cell)!;
    for (const value of domains.get(cell)!) {
      assignments[index] = value;
      if (partialValid()) search(depth + 1);
      assignments[index] = -1;
      if (timedOut || solutions.size >= solutionLimit) return;
    }
  }

  if (!initialConflict) search(0);
  return { count: solutions.size, timedOut, exploredNodes, elapsedMs: performance.now() - started };
}

function pairDifferences(values: number[]) {
  let count = 0;
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) if (Math.abs(values[left] - values[right]) === 1) count += 1;
  }
  return count;
}

function visible(values: number[]) {
  const result: number[] = [];
  let maximum = 0;
  for (const value of values) {
    if (value <= maximum) continue;
    maximum = value;
    result.push(value);
  }
  return result;
}

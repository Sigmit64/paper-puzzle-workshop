import assert from "node:assert/strict";
import { init, killThreads } from "z3-solver/build/node.js";
import { solveLoop } from "../src/game/solver-loop";
import { compileBoard } from "../src/game/solver";
import { CARD_DEFINITIONS } from "../src/game/catalog";
import { createLoopZ3Session, LoopZ3UnsupportedError, LOOP_Z3_RULES, solveLoopZ3 } from "../src/game/solver-loop-z3";
import { createLoopZ3Model, fixtureCellClue } from "../src/game/loop-z3-fixture";
import { acceptLoopPilotCandidate, loopSegmentsFromSignature, validateLoopPilotSolution, validateLoopSolution } from "../src/game/loop-pilot-validator";

const api = await init();
try {
  async function both(model: ReturnType<typeof createLoopZ3Model>) {
    const legacy = solveLoop(model);
    const z3 = await solveLoopZ3(createLoopZ3Session(api, model), model.timeBudgetMs);
    const legacyStatus = legacy.timedOut ? "timeout" : legacy.count === 0 ? "unsat" : legacy.count === 1 ? "unique" : "multiple";
    assert.equal(z3.classification, legacyStatus, `${model.board.name}: legacy=${legacyStatus}, z3=${z3.classification}`);
    for (const [index, solution] of legacy.solutions.entries()) {
      const validation = validateLoopSolution(model, solution.loop ?? []);
      assert.equal(validation.valid, true, `${model.board.name}: legacy solution ${index + 1} invalid: ${validation.errors.join("; ")}`);
    }
    for (const [index, candidate] of z3.signatures.entries()) {
      const validation = validateLoopSolution(model, loopSegmentsFromSignature(candidate));
      assert.equal(validation.valid, true, `${model.board.name}: Z3 solution ${index + 1} invalid: ${validation.errors.join("; ")}`);
    }
    if (z3.classification === "multiple") {
      assert.equal(z3.signatures.length, 2, `${model.board.name}: multiple must expose two solutions`);
      assert.notEqual(z3.signatures[0], z3.signatures[1], `${model.board.name}: Z3 solutions must differ`);
    }
    if (z3.classification === "unique" && legacy.count === 1) {
      assert.equal(z3.signatures[0], legacy.solutions[0]?.loop?.map((edge) => {
        const left = edge.from < edge.to ? edge.from : edge.to;
        const right = edge.from < edge.to ? edge.to : edge.from;
        return `${left}-${right}`;
      }).sort().join("|"), `${model.board.name}: unique signature mismatch`);
    }
    return { legacy, z3 };
  }

  function compiledCarrier(board: Parameters<typeof compileBoard>[0]) {
    const compiled = compileBoard(board);
    assert.equal("status" in compiled, false, `mutation carrier failed to compile: ${board.name}`);
    return compiled as ReturnType<typeof createLoopZ3Model>;
  }

  function controlWithout(model: ReturnType<typeof createLoopZ3Model>, key: string, name: string) {
    return {
      ...model,
      board: { ...model.board, name },
      clueRules: model.clueRules.filter((rule) => rule.key !== key),
    };
  }

  function assertControlLoopRejectedByTarget(target: ReturnType<typeof createLoopZ3Model>, control: Awaited<ReturnType<typeof both>>, label: string) {
    const loop = control.legacy.solutions[0]?.loop;
    assert.ok(loop, `${label}: control must expose a candidate for validator mutation evidence`);
    const validation = validateLoopSolution(target, loop);
    assert.equal(validation.valid, false, `${label}: shared validator accepted the target-invalid control candidate`);
  }

  const unique = createLoopZ3Model({ rows: 2, columns: 2, globalRuleKeys: ["loop.visit-all-unclued-cells"], name: "unique-2x2" });
  const uniqueResult = await both(unique);
  assert.equal(uniqueResult.z3.classification, "unique");
  assert.equal(uniqueResult.z3.signatures.length, 1);

  const multiple = createLoopZ3Model({ rows: 4, columns: 4, globalRuleKeys: ["loop.visit-all-unclued-cells"], name: "multiple-4x4" });
  const multipleResult = await both(multiple);
  assert.equal(multipleResult.z3.classification, "multiple");
  assert.equal(multipleResult.z3.signatures.length, 2);
  assert.notEqual(multipleResult.z3.signatures[0], multipleResult.z3.signatures[1]);
  const multipleLimitOne = { ...multiple, solutionLimit: 1, board: { ...multiple.board, name: "multiple-4x4-limit-one" } };
  const multipleLimitOneZ3 = await solveLoopZ3(createLoopZ3Session(api, multipleLimitOne), multipleLimitOne.timeBudgetMs);
  assert.equal(multipleLimitOneZ3.classification, "multiple");
  assert.equal(multipleLimitOneZ3.checks, 2, "solutionLimit=1 must still perform complete blocking check");
  assert.equal(multipleLimitOneZ3.signatures.length, 1, "solutionLimit controls retained signatures, not classification");

  const unsat = createLoopZ3Model({ rows: 3, columns: 3, globalRuleKeys: ["loop.visit-all-unclued-cells"], name: "unsat-3x3" });
  const unsatResult = await both(unsat);
  assert.equal(unsatResult.z3.classification, "unsat");

  const straightUnsat = createLoopZ3Model({
    rows: 2,
    columns: 2,
    globalRuleKeys: ["loop.visit-all-unclued-cells"],
    name: "straight-corner-unsat",
    clues: [fixtureCellClue("straight", "white-dot", "0:0")],
    clueRules: [{ key: "loop.white-dot.straight", clueKind: "white-dot", sourceCardInstanceId: "straight" }],
  });
  assert.equal((await both(straightUnsat)).z3.classification, "unsat");

  const turnUnique = createLoopZ3Model({
    rows: 2,
    columns: 2,
    globalRuleKeys: ["loop.visit-all-unclued-cells"],
    name: "turn-corner-unique",
    clues: [fixtureCellClue("turn", "black-dot", "0:0")],
    clueRules: [{ key: "loop.black-dot.turn", clueKind: "black-dot", sourceCardInstanceId: "turn" }],
  });
  assert.equal((await both(turnUnique)).z3.classification, "unique");

  const masyuBlackNoValue = createLoopZ3Model({
    rows: 2,
    columns: 2,
    globalRuleKeys: ["loop.visit-all-unclued-cells"],
    name: "masyu-black-no-value-carrier",
    clues: [fixtureCellClue("masyu-black", "black-dot", "0:0")],
    clueRules: [{ key: "loop.cell-dot.masyu-black", clueKind: "black-dot", sourceCardInstanceId: "masyu-black" }],
  });
  const masyuBlackNoValueResult = await both(masyuBlackNoValue);
  assert.equal(masyuBlackNoValueResult.legacy.count, 0);
  assert.equal(masyuBlackNoValueResult.z3.classification, "unsat");

  // This regression deliberately goes through compileBoard/card carriers:
  // dot clues have no numeric value field, unlike number carriers.
  const compiledMasyuCarrier = compileBoard({
    id: "compiled-masyu-black-no-value",
    name: "compiled-masyu-black-no-value",
    rows: 2,
    columns: 2,
    activeCells: ["0:0", "0:1", "1:0", "1:1"],
    ruleCapacity: 20,
    mechanic: "loop",
    globalCards: [{ instanceId: "carrier-global", definitionId: "rule-loop-visit-all-unclued" }],
    clueCards: [{ instanceId: "carrier-clue", definitionId: "clue-loop-cell-dot-masyu-black", placedClueId: "carrier-dot" }],
    clues: [{ id: "carrier-dot", kind: "black-dot", anchor: { kind: "cell", cell: "0:0" }, sourceCardInstanceId: "carrier-clue" }],
    draftStrokes: [],
    revision: 0,
  });
  assert.equal("status" in compiledMasyuCarrier, false, "compileBoard must produce a valid no-value dot carrier");
  const compiledCarrierResult = await both(compiledMasyuCarrier as ReturnType<typeof createLoopZ3Model>);
  assert.equal(compiledCarrierResult.z3.classification, "unsat");

  const orthogonalState2 = createLoopZ3Model({
    rows: 4,
    columns: 4,
    name: "orthogonal-unvisited-state2-carriers",
    globalRuleKeys: ["loop.unvisited-not-adjacent"],
    clues: [
      { id: "number-a", kind: "cell-number", anchor: { kind: "cell", cell: "1:1" }, value: 0, sourceCardInstanceId: "number-a" },
      { id: "number-b", kind: "cell-number", anchor: { kind: "cell", cell: "1:2" }, value: 0, sourceCardInstanceId: "number-b" },
    ],
    clueRules: [
      { key: "loop.cell-number.orthogonal-unvisited", clueKind: "cell-number", sourceCardInstanceId: "number-a" },
    ],
  });
  const orthogonalState2Result = await both(orthogonalState2);
  assert.equal(orthogonalState2Result.legacy.count > 1, true, "legacy ungated orthogonal state2 case should remain multiple");
  assert.equal(orthogonalState2Result.z3.classification, "multiple");

  // eight-unvisited deliberately differs from orthogonal-unvisited: the
  // legacy binaryClues count includes neighboring state-2 clue cells.  Two
  // adjacent internal number carriers therefore each see the other as the
  // sole unvisited neighbor while visit-all fixes the surrounding loop.
  const eightUnvisitedState2 = createLoopZ3Model({
    rows: 4,
    columns: 4,
    name: "eight-unvisited-state2-carriers",
    globalRuleKeys: ["loop.visit-all-unclued-cells"],
    clues: [
      { id: "eight-a", kind: "cell-number", anchor: { kind: "cell", cell: "1:1" }, value: 1, sourceCardInstanceId: "eight-a" },
      { id: "eight-b", kind: "cell-number", anchor: { kind: "cell", cell: "1:2" }, value: 1, sourceCardInstanceId: "eight-b" },
    ],
    clueRules: [
      { key: "loop.cell-number.eight-unvisited", clueKind: "cell-number", sourceCardInstanceId: "eight-a" },
      { key: "loop.cell-number.eight-unvisited", clueKind: "cell-number", sourceCardInstanceId: "eight-b" },
    ],
  });
  const eightUnvisitedState2Result = await both(eightUnvisitedState2);
  assert.equal(eightUnvisitedState2Result.legacy.count, 1, "eight-unvisited state2 regression must be legacy-unique");
  assert.equal(eightUnvisitedState2Result.z3.classification, "unique");

  const exteriorLongest = createLoopZ3Model({
    rows: 2,
    columns: 4,
    name: "exterior-longest-grouping",
    globalRuleKeys: ["loop.visit-all-unclued-cells"],
    clues: [{ id: "exterior-longest", kind: "exterior-number", anchor: { kind: "exterior", side: "left", index: 0 }, value: 3, sourceCardInstanceId: "exterior-longest" }],
    clueRules: [{ key: "loop.exterior-number.longest-parallel-segment", clueKind: "exterior-number", sourceCardInstanceId: "exterior-longest" }],
  });
  const exteriorLongestResult = await both(exteriorLongest);
  assert.equal(exteriorLongestResult.legacy.count, 1);
  assert.equal(exteriorLongestResult.z3.classification, "unique");

  // Mutation-sensitive control/target pairs all share the same fixed or
  // sufficiently constrained ring.  The target is produced through the real
  // compileBoard carrier; the control removes only that target assertion.
  const equalArmTarget = compiledCarrier({
    id: "equal-arm-control-target", name: "equal-arm-target", rows: 2, columns: 4,
    activeCells: ["0:0", "0:1", "0:2", "0:3", "1:0", "1:1", "1:2", "1:3"], ruleCapacity: 30, mechanic: "loop",
    globalCards: [{ instanceId: "equal-global", definitionId: "rule-loop-visit-all-unclued" }],
    clueCards: [
      { instanceId: "equal-visited", definitionId: "clue-loop-cell-dot-visited-white", placedClueId: "equal-dot" },
      { instanceId: "equal-target", definitionId: "clue-loop-cell-dot-equal-arms-white", placedClueId: "equal-dot" },
    ],
    clues: [{ id: "equal-dot", kind: "white-dot", anchor: { kind: "cell", cell: "0:0" }, sourceCardInstanceId: "equal-visited" }],
    draftStrokes: [], revision: 0,
  });
  const equalArmControl = controlWithout(equalArmTarget, "loop.cell-dot.equal-arm-lengths", "equal-arm-control");
  const equalArmControlResult = await both(equalArmControl);
  assert.equal(equalArmControlResult.z3.classification, "unique", "equal-arm control ring must be unique");
  assertControlLoopRejectedByTarget(equalArmTarget, equalArmControlResult, "equal-arm");
  assert.equal((await both(equalArmTarget)).z3.classification, "unsat", "equal-arm target must reject the unequal corner arms");

  const midpointTarget = compiledCarrier({
    id: "midpoint-control-target", name: "midpoint-target", rows: 2, columns: 4,
    activeCells: ["0:0", "0:1", "0:2", "0:3", "1:0", "1:1", "1:2", "1:3"], ruleCapacity: 30, mechanic: "loop",
    globalCards: [{ instanceId: "midpoint-global", definitionId: "rule-loop-visit-all-unclued" }],
    clueCards: [
      { instanceId: "midpoint-used", definitionId: "clue-loop-edge-dot-through-white", placedClueId: "midpoint-dot" },
      { instanceId: "midpoint-target", definitionId: "clue-loop-edge-dot-midpoint-white", placedClueId: "midpoint-dot" },
    ],
    clues: [{ id: "midpoint-dot", kind: "edge-white-dot", anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 }, sourceCardInstanceId: "midpoint-used" }],
    draftStrokes: [], revision: 0,
  });
  const midpointControl = controlWithout(midpointTarget, "loop.edge-dot.segment-midpoint", "midpoint-control");
  const midpointControlResult = await both(midpointControl);
  assert.equal(midpointControlResult.z3.classification, "unique", "midpoint control ring must be unique");
  assertControlLoopRejectedByTarget(midpointTarget, midpointControlResult, "midpoint");
  assert.equal((await both(midpointTarget)).z3.classification, "unsat", "midpoint target must reject the off-center edge");

  const exteriorLongestTarget = compiledCarrier({
    id: "exterior-longest-control-target", name: "exterior-longest-target", rows: 2, columns: 4,
    activeCells: ["0:0", "0:1", "0:2", "0:3", "1:0", "1:1", "1:2", "1:3"], ruleCapacity: 20, mechanic: "loop",
    globalCards: [{ instanceId: "exterior-global", definitionId: "rule-loop-visit-all-unclued" }],
    clueCards: [{ instanceId: "exterior-target", definitionId: "clue-loop-exterior-number-longest-segment", placedClueId: "exterior-target" }],
    clues: [{ id: "exterior-target", kind: "exterior-number", anchor: { kind: "exterior", side: "left", index: 0 }, value: 2, sourceCardInstanceId: "exterior-target" }],
    draftStrokes: [], revision: 0,
  });
  const exteriorLongestControl = controlWithout(exteriorLongestTarget, "loop.exterior-number.longest-parallel-segment", "exterior-longest-control");
  const exteriorLongestControlResult = await both(exteriorLongestControl);
  assert.equal(exteriorLongestControlResult.z3.classification, "unique", "exterior-longest control perimeter must be unique");
  assertControlLoopRejectedByTarget(exteriorLongestTarget, exteriorLongestControlResult, "exterior-longest");
  assert.equal((await both(exteriorLongestTarget)).z3.classification, "unsat", "exterior-longest target must reject 2 versus the observed 3");

  const insideTarget = compiledCarrier({
    id: "inside-control-target", name: "inside-target", rows: 2, columns: 4,
    activeCells: ["0:0", "0:1", "0:2", "0:3", "1:0", "1:1", "1:2", "1:3"], ruleCapacity: 20, mechanic: "loop",
    globalCards: [{ instanceId: "inside-global", definitionId: "rule-loop-visit-all-unclued" }],
    clueCards: [{ instanceId: "inside-target", definitionId: "clue-loop-vertex-dot-inside-white", placedClueId: "inside-target" }],
    clues: [{ id: "inside-target", kind: "vertex-white-dot", anchor: { kind: "vertex", row: 0, column: 0 }, sourceCardInstanceId: "inside-target" }],
    draftStrokes: [], revision: 0,
  });
  const insideControl = controlWithout(insideTarget, "loop.vertex-dot.inside", "inside-control");
  const insideControlResult = await both(insideControl);
  assert.equal(insideControlResult.z3.classification, "unique", "inside control perimeter must be unique");
  assertControlLoopRejectedByTarget(insideTarget, insideControlResult, "inside");
  assert.equal((await both(insideTarget)).z3.classification, "unsat", "inside target must reject the outside corner vertex");

  const centerSymmetryClues = [
    { id: "center-dot", kind: "black-dot", anchor: { kind: "cell", cell: "0:0" }, sourceCardInstanceId: "center-dot" },
    { id: "center-dot-adjacent", kind: "black-dot", anchor: { kind: "cell", cell: "0:1" }, sourceCardInstanceId: "center-dot-adjacent" },
  ];
  const centerTarget = compiledCarrier({
    id: "center-symmetry-control-target", name: "center-symmetry-target", rows: 4, columns: 4,
    activeCells: Array.from({ length: 16 }, (_, index) => `${Math.floor(index / 4)}:${index % 4}`), ruleCapacity: 20, mechanic: "loop",
    globalCards: [{ instanceId: "center-global", definitionId: "rule-loop-visit-all-unclued" }],
    clueCards: [
      { instanceId: "center-unvisited", definitionId: "clue-loop-cell-dot-unvisited-black", placedClueId: "center-dot" },
      { instanceId: "center-target", definitionId: "clue-loop-cell-dot-unvisited-center-symmetry-black", placedClueId: "center-dot" },
    ],
    clues: centerSymmetryClues as never,
    draftStrokes: [], revision: 0,
  });
  const centerControl = controlWithout(centerTarget, "loop.cell-dot.unvisited-component-center-symmetric", "center-symmetry-control");
  const centerControlResult = await both(centerControl);
  assert.notEqual(centerControlResult.z3.classification, "unsat", "center-symmetry control must remain SAT when target assertion is removed");
  assertControlLoopRejectedByTarget(centerTarget, centerControlResult, "center-symmetry");
  assert.equal((await both(centerTarget)).z3.classification, "unsat", "center-symmetry target must reject the asymmetric interior component");

  const traversedUnique = createLoopZ3Model({
    rows: 2,
    columns: 2,
    globalRuleKeys: ["loop.visit-all-unclued-cells"],
    name: "traversed-edge-unique",
    clues: [{ id: "edge", kind: "edge-white-dot", anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 }, sourceCardInstanceId: "edge" }],
    clueRules: [{ key: "loop.edge-dot.traversed", clueKind: "edge-white-dot", sourceCardInstanceId: "edge" }],
  });
  assert.equal((await both(traversedUnique)).z3.classification, "unique");

  const notTraversedUnsat = createLoopZ3Model({
    rows: 2,
    columns: 2,
    globalRuleKeys: ["loop.visit-all-unclued-cells"],
    name: "not-traversed-edge-unsat",
    clues: [{ id: "edge", kind: "edge-black-dot", anchor: { kind: "edge", orientation: "vertical", row: 0, column: 1 }, sourceCardInstanceId: "edge" }],
    clueRules: [{ key: "loop.edge-dot.not-traversed", clueKind: "edge-black-dot", sourceCardInstanceId: "edge" }],
  });
  assert.equal((await both(notTraversedUnsat)).z3.classification, "unsat");

  const twoSubtours = createLoopZ3Model({
    rows: 4,
    columns: 4,
    name: "subtour-exclusion",
    clues: [
      ...["0:0", "0:1", "1:0", "1:1", "2:2", "2:3", "3:2", "3:3"].map((cell, index) => fixtureCellClue(`visited-${index}`, "white-dot", cell as `${number}:${number}`)),
      ...["0:2", "0:3", "1:2", "1:3", "2:0", "2:1", "3:0", "3:1"].map((cell, index) => fixtureCellClue(`unvisited-${index}`, "black-dot", cell as `${number}:${number}`)),
    ],
    clueRules: [
      { key: "loop.cell-dot.visited", clueKind: "white-dot", sourceCardInstanceId: "visited" },
      { key: "loop.cell-dot.unvisited", clueKind: "black-dot", sourceCardInstanceId: "unvisited" },
    ],
  });
  const subtourResult = await both(twoSubtours);
  assert.equal(subtourResult.z3.classification, "unsat");

  const gap = createLoopZ3Model({
    rows: 2,
    columns: 3,
    activeCells: ["0:0", "1:0", "0:2", "1:2"],
    globalRuleKeys: ["loop.visit-all-unclued-cells"],
    name: "deleted-column-gap",
  });
  const gapResult = await both(gap);
  assert.equal(gapResult.z3.classification, "unsat");
  assert.equal(gapResult.legacy.count, 0);
  const bridgedMutation = validateLoopPilotSolution(gap, [
    { from: "0:0", to: "0:1" },
    { from: "0:1", to: "0:2" },
  ]);
  assert.equal(bridgedMutation.valid, false, "validator must reject a bridge across deleted cells");
  assert.match(bridgedMutation.errors.join(";"), /active topology/);
  assert.equal(acceptLoopPilotCandidate(gap, [{ from: "0:0", to: "0:1" }], "0:0-0:1"), false, "legacy acceptance gate must reject a deleted-cell bridge");

  const unsupported = createLoopZ3Model({ rows: 2, columns: 2, globalRuleKeys: ["loop.unknown-test-rule"] });
  assert.throws(() => createLoopZ3Session(api, unsupported), (error: unknown) => error instanceof LoopZ3UnsupportedError && error.code === "unsupported");

  // Build one independent model per registered key.  This exercises the
  // encoder dispatch and anchor/topology path for every rule; aliases for the
  // two historical dot cards are included in the registry but excluded from
  // the 46-key solver-coverage denominator.
  const explicitRules = LOOP_Z3_RULES.filter((key) => !["loop.single-cycle", "loop.white-dot.straight", "loop.black-dot.turn"].includes(key));
  for (const key of LOOP_Z3_RULES) {
    const isGlobal = key === "loop.single-cycle" || key === "loop.unvisited-not-adjacent" || key === "loop.visit-all-unclued-cells";
    const kind = key.startsWith("loop.cell-number") ? "cell-number"
      : key.startsWith("loop.edge-number") ? "edge-number"
        : key.startsWith("loop.vertex-number") ? "vertex-number"
          : key.startsWith("loop.exterior-number") ? "exterior-number"
            : key.startsWith("loop.edge-dot") ? "edge-white-dot"
              : key.startsWith("loop.vertex-dot") ? "vertex-white-dot"
                : key.includes("white-dot") ? "white-dot" : "black-dot";
    const clue = kind === "cell-number" || kind === "white-dot" || kind === "black-dot"
      ? { id: `coverage-${key}`, kind, anchor: { kind: "cell", cell: "1:1" }, value: 1, sourceCardInstanceId: "coverage" }
      : kind === "edge-number" || kind === "edge-white-dot"
        ? { id: `coverage-${key}`, kind, anchor: { kind: "edge", orientation: "vertical", row: 1, column: 1 }, value: 1, sourceCardInstanceId: "coverage" }
        : kind === "vertex-number" || kind === "vertex-white-dot"
          ? { id: `coverage-${key}`, kind, anchor: { kind: "vertex", row: 1, column: 1 }, value: 1, sourceCardInstanceId: "coverage" }
          : { id: `coverage-${key}`, kind, anchor: { kind: "exterior", side: "left", index: 1 }, value: 1, sourceCardInstanceId: "coverage" };
    const model = createLoopZ3Model({ rows: 4, columns: 4, name: `coverage-${key}`, globalRuleKeys: isGlobal ? [key] : [], clues: isGlobal ? [] : [clue as never], clueRules: isGlobal ? [] : [{ key, clueKind: kind as never, sourceCardInstanceId: "coverage" }] });
    assert.doesNotThrow(() => createLoopZ3Session(api, model), `encoder rejected registered rule ${key}`);
  }

  // Repeat dispatch through the product's real card compiler. This catches
  // carrier shape mistakes (especially value-less dot cards) that a hand-built
  // CompiledPuzzle cannot expose.
  for (const key of LOOP_Z3_RULES) {
    const definition = CARD_DEFINITIONS.find((candidate) => candidate.ruleKey === key || candidate.clue?.ruleKeys?.loop === key);
    assert.ok(definition, `missing catalog carrier for ${key}`);
    const isGlobal = definition!.kind === "global";
    const clueKind = definition!.clue?.kind;
    const anchor = clueKind === "cell-number" || clueKind === "white-dot" || clueKind === "black-dot"
      ? { kind: "cell", cell: "1:1" }
      : clueKind === "edge-number" || clueKind === "edge-white-dot" || clueKind === "edge-black-dot"
        ? { kind: "edge", orientation: "vertical", row: 1, column: 1 }
        : clueKind === "vertex-number" || clueKind === "vertex-white-dot" || clueKind === "vertex-black-dot"
          ? { kind: "vertex", row: 1, column: 1 }
          : { kind: "exterior", side: "left", index: 1 };
    const carrierBoard = {
      id: `compiled-carrier-${key}`, name: `compiled-carrier-${key}`, rows: 4, columns: 4,
      activeCells: Array.from({ length: 16 }, (_, index) => `${Math.floor(index / 4)}:${index % 4}`), ruleCapacity: 20, mechanic: "loop" as const,
      globalCards: isGlobal ? [{ instanceId: "compiled-global", definitionId: definition!.id }] : [{ instanceId: "compiled-single", definitionId: "rule-single-loop" }],
      clueCards: isGlobal ? [] : [{ instanceId: "compiled-clue", definitionId: definition!.id, placedClueId: "compiled-clue" }],
      clues: isGlobal ? [] : [{ id: "compiled-clue", kind: clueKind!, anchor, ...(clueKind === "cell-number" || clueKind?.endsWith("number") ? { value: 1 } : {}), sourceCardInstanceId: "compiled-clue" }],
      draftStrokes: [], revision: 0,
    };
    const compiled = compileBoard(carrierBoard);
    assert.equal("status" in compiled, false, `catalog carrier failed to compile for ${key}`);
    assert.doesNotThrow(() => createLoopZ3Session(api, compiled as never), `compiled carrier rejected by encoder for ${key}`);
  }

  // Semantic coverage also solves the compiled carrier, rather than merely
  // constructing it. Numeric carriers use their catalog minimum (valid
  // value); dot carriers intentionally omit value altogether.
  const compiledSemanticEvidence: Array<{ key: string; legacy: string; z3: string }> = [];
  for (const key of explicitRules) {
    const definition = CARD_DEFINITIONS.find((candidate) => candidate.ruleKey === key || candidate.clue?.ruleKeys?.loop === key)!;
    const isGlobal = definition.kind === "global";
    const clueKind = definition.clue?.kind;
    const anchor = clueKind === "cell-number" || clueKind === "white-dot" || clueKind === "black-dot"
      ? { kind: "cell", cell: "0:0" }
      : clueKind === "edge-number" || clueKind === "edge-white-dot" || clueKind === "edge-black-dot"
        ? { kind: "edge", orientation: "vertical", row: 0, column: 1 }
        : clueKind === "vertex-number" || clueKind === "vertex-white-dot" || clueKind === "vertex-black-dot"
          ? { kind: "vertex", row: 1, column: 1 }
          : { kind: "exterior", side: "left", index: 0 };
    const numeric = clueKind?.endsWith("number") === true;
    const carrierBoard = {
      id: `semantic-carrier-${key}`, name: `semantic-carrier-${key}`, rows: 2, columns: 2,
      activeCells: ["0:0", "0:1", "1:0", "1:1"], ruleCapacity: 20, mechanic: "loop" as const,
      globalCards: isGlobal ? [{ instanceId: "semantic-global", definitionId: definition.id }] : [{ instanceId: "semantic-single", definitionId: "rule-single-loop" }],
      clueCards: isGlobal ? [] : [{ instanceId: "semantic-clue", definitionId: definition.id, placedClueId: "semantic-clue" }],
      clues: isGlobal ? [] : [{ id: "semantic-clue", kind: clueKind!, anchor, ...(numeric ? { value: definition.clue!.min } : {}), sourceCardInstanceId: "semantic-clue" }],
      draftStrokes: [], revision: 0,
    };
    const compiled = compileBoard(carrierBoard);
    assert.equal("status" in compiled, false, `semantic carrier failed to compile for ${key}`);
    const legacy = solveLoop(compiled as never);
    const z3 = await solveLoopZ3(createLoopZ3Session(api, compiled as never), (compiled as { timeBudgetMs: number }).timeBudgetMs);
    const legacyStatus = legacy.timedOut ? "timeout" : legacy.count === 0 ? "unsat" : legacy.count === 1 ? "unique" : "multiple";
    assert.equal(z3.classification, legacyStatus, `compiled semantic carrier ${key}: legacy=${legacyStatus}, z3=${z3.classification}`);
    compiledSemanticEvidence.push({ key, legacy: legacyStatus, z3: z3.classification });
  }

  // Small parity probes exercise every rule's actual assertion path (not just
  // registration).  A target of one is intentionally not treated as a
  // handcrafted answer; each backend must classify the unconstrained 4x4
  // topology independently.
  const coverageEvidence: Array<{ key: string; legacy: string; z3: string }> = [];
  for (const key of explicitRules) {
    const isGlobal = key === "loop.unvisited-not-adjacent" || key === "loop.visit-all-unclued-cells";
    const kind = key.startsWith("loop.cell-number") ? "cell-number"
      : key.startsWith("loop.edge-number") ? "edge-number"
        : key.startsWith("loop.vertex-number") ? "vertex-number"
          : key.startsWith("loop.exterior-number") ? "exterior-number"
            : key.startsWith("loop.edge-dot") ? "edge-white-dot"
              : key.startsWith("loop.vertex-dot") ? "vertex-white-dot"
                : key.includes("white-dot") ? "white-dot" : "black-dot";
    const clue = kind === "cell-number" || kind === "white-dot" || kind === "black-dot"
      ? { id: `parity-${key}`, kind, anchor: { kind: "cell", cell: "1:1" }, value: 1, sourceCardInstanceId: "parity" }
      : kind === "edge-number" || kind === "edge-white-dot"
        ? { id: `parity-${key}`, kind, anchor: { kind: "edge", orientation: "vertical", row: 1, column: 1 }, value: 1, sourceCardInstanceId: "parity" }
        : kind === "vertex-number" || kind === "vertex-white-dot"
          ? { id: `parity-${key}`, kind, anchor: { kind: "vertex", row: 1, column: 1 }, value: 1, sourceCardInstanceId: "parity" }
          : { id: `parity-${key}`, kind, anchor: { kind: "exterior", side: "left", index: 1 }, value: 1, sourceCardInstanceId: "parity" };
    const model = createLoopZ3Model({ rows: 2, columns: 2, name: `parity-${key}`, timeBudgetMs: 2500, globalRuleKeys: isGlobal ? [key] : [], clues: isGlobal ? [] : [clue as never], clueRules: isGlobal ? [] : [{ key, clueKind: kind as never, sourceCardInstanceId: "parity" }] });
    const legacy = solveLoop(model);
    const z3 = await solveLoopZ3(createLoopZ3Session(api, model), model.timeBudgetMs);
    const legacyStatus = legacy.timedOut ? "timeout" : legacy.count === 0 ? "unsat" : legacy.count === 1 ? "unique" : "multiple";
    assert.equal(z3.classification, legacyStatus, `${key}: legacy=${legacyStatus}, z3=${z3.classification}`);
    coverageEvidence.push({ key, legacy: legacyStatus, z3: z3.classification });
  }

  assert.equal(compiledSemanticEvidence.length, 46);
  console.log(JSON.stringify({ status: "PASS", coverage: `${compiledSemanticEvidence.length}/46`, coverageEvidence: compiledSemanticEvidence, cases: ["unique", "multiple", "solution-limit-one", "unsat", "no-value-carrier", "orthogonal-state2", "eight-unvisited-state2", "exterior-grouping", "equal-arm-control-target", "midpoint-control-target", "inside-control-target", "exterior-longest-control-target", "center-symmetry-control-target", "subtour-exclusion", "deleted-column-gap", "unsupported"] }));
} finally {
  await killThreads(api.em);
}

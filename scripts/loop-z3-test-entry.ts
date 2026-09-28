import assert from "node:assert/strict";
import { init, killThreads } from "z3-solver/build/node.js";
import { solveLoop } from "../src/game/solver-loop";
import { createLoopZ3Session, LoopZ3UnsupportedError, solveLoopZ3 } from "../src/game/solver-loop-z3";
import { createLoopZ3Model, fixtureCellClue } from "../src/game/loop-z3-fixture";
import { acceptLoopPilotCandidate, loopSegmentsFromSignature, validateLoopPilotSolution } from "../src/game/loop-pilot-validator";

const api = await init();
try {
  async function both(model: ReturnType<typeof createLoopZ3Model>) {
    const legacy = solveLoop(model);
    const z3 = await solveLoopZ3(createLoopZ3Session(api, model), model.timeBudgetMs);
    const legacyStatus = legacy.timedOut ? "timeout" : legacy.count === 0 ? "unsat" : legacy.count === 1 ? "unique" : "multiple";
    assert.equal(z3.classification, legacyStatus, `${model.board.name}: legacy=${legacyStatus}, z3=${z3.classification}`);
    for (const [index, solution] of legacy.solutions.entries()) {
      const validation = validateLoopPilotSolution(model, solution.loop ?? []);
      assert.equal(validation.valid, true, `${model.board.name}: legacy solution ${index + 1} invalid: ${validation.errors.join("; ")}`);
    }
    for (const [index, candidate] of z3.signatures.entries()) {
      const validation = validateLoopPilotSolution(model, loopSegmentsFromSignature(candidate));
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

  const unique = createLoopZ3Model({ rows: 2, columns: 2, globalRuleKeys: ["loop.visit-all-unclued-cells"], name: "unique-2x2" });
  const uniqueResult = await both(unique);
  assert.equal(uniqueResult.z3.classification, "unique");
  assert.equal(uniqueResult.z3.signatures.length, 1);

  const multiple = createLoopZ3Model({ rows: 4, columns: 4, globalRuleKeys: ["loop.visit-all-unclued-cells"], name: "multiple-4x4" });
  const multipleResult = await both(multiple);
  assert.equal(multipleResult.z3.classification, "multiple");
  assert.equal(multipleResult.z3.signatures.length, 2);
  assert.notEqual(multipleResult.z3.signatures[0], multipleResult.z3.signatures[1]);

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

  const unsupported = createLoopZ3Model({ rows: 2, columns: 2, globalRuleKeys: ["loop.unvisited-not-adjacent"] });
  assert.throws(() => createLoopZ3Session(api, unsupported), (error: unknown) => error instanceof LoopZ3UnsupportedError && error.code === "unsupported");

  console.log(JSON.stringify({ status: "PASS", cases: ["unique", "multiple", "unsat", "straight", "turn", "traversed", "not-traversed", "subtour-exclusion", "deleted-column-gap", "unsupported"] }));
} finally {
  await killThreads(api.em);
}

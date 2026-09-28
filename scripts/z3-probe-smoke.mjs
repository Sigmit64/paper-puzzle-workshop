import assert from "node:assert/strict";
import { init, killThreads } from "z3-solver/build/node.js";

const started = performance.now();
let api;
try {
  api = await init();
  const { Context } = api;
  const { Int, Or, Solver } = new Context("z3-node-probe");
  const x = Int.const("x");
  const y = Int.const("y");
  const solver = new Solver();
  solver.add(x.ge(0), x.le(1), y.ge(0), y.le(1), x.eq(0), y.eq(1));

  const first = await solver.check();
  assert.equal(first, "sat", `expected first check to be sat, got ${first}`);
  const model = solver.model();
  const answer = { x: model.get(x).value(), y: model.get(y).value() };
  assert.deepEqual(answer, { x: 0n, y: 1n }, "canonical finite-domain projection changed");

  solver.add(Or(x.neq(answer.x), y.neq(answer.y)));
  const second = await solver.check();
  assert.equal(second, "unsat", `expected blocking check to be unsat, got ${second}`);

  console.log(JSON.stringify({
    status: "PASS",
    first,
    second,
    answer: `x=${answer.x}, y=${answer.y}`,
    totalMs: Number((performance.now() - started).toFixed(1)),
    threadsCleaned: true,
  }));
} finally {
  if (api) await killThreads(api.em);
}

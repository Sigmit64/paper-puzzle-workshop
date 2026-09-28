import assert from "node:assert/strict";
import { createLoopZ3Model } from "../src/game/loop-z3-fixture";
import { LoopZ3Client, type LoopWorkerRequest, type LoopWorkerResponse } from "../src/game/loop-z3-client";

const model = createLoopZ3Model({ rows: 2, columns: 2, globalRuleKeys: ["loop.visit-all-unclued-cells"], name: "client-test" });
const clonedModel = structuredClone(model);
assert.deepEqual(clonedModel.globalRuleKeys, model.globalRuleKeys);
assert.deepEqual(clonedModel.clueRules, model.clueRules);
assert.equal(clonedModel.board.activeCells.length, model.board.activeCells.length);
const result = { boardName: model.board.name, status: "unique" as const, baseScore: 0, awardedScore: 0, detail: "ok", solverStats: { solutionsFound: 1, exploredNodes: 2, elapsedMs: 1, backend: "z3" as const } };

class FakeWorker {
  private messageListeners = new Set<(event: MessageEvent<LoopWorkerResponse>) => void>();
  private errorListeners = new Set<(event: ErrorEvent) => void>();
  private messageErrorListeners = new Set<(event: MessageEvent) => void>();
  readonly requests: LoopWorkerRequest[] = [];
  terminated = false;
  postMessage(message: LoopWorkerRequest): void { this.requests.push(message); }
  addEventListener(type: "message" | "error" | "messageerror", listener: any): void { (type === "message" ? this.messageListeners : type === "error" ? this.errorListeners : this.messageErrorListeners).add(listener); }
  removeEventListener(type: "message" | "error" | "messageerror", listener: any): void { (type === "message" ? this.messageListeners : type === "error" ? this.errorListeners : this.messageErrorListeners).delete(listener); }
  respond(response: LoopWorkerResponse): void { for (const listener of this.messageListeners) listener({ data: response } as MessageEvent<LoopWorkerResponse>); }
  crash(message = "test crash"): void { for (const listener of this.errorListeners) listener({ message } as ErrorEvent); }
  messageError(): void { for (const listener of this.messageErrorListeners) listener({} as MessageEvent); }
  terminate(): void { this.terminated = true; }
}

const previousWorker = (globalThis as { Worker?: unknown }).Worker;
(globalThis as { Worker: unknown }).Worker = FakeWorker;
try {
  const worker = new FakeWorker();
  const client = new LoopZ3Client(() => worker as never);
  const first = client.solve(model);
  assert.equal(worker.requests.length, 1);
  const firstRequest = worker.requests[0]!;
  const duplicate = client.solve(model);
  await assert.rejects(duplicate, /LOOP_SOLVER_BUSY/);
  worker.respond({ type: "result", requestId: "stale-request", result });
  worker.respond({ type: "result", requestId: firstRequest.requestId, result });
  assert.equal((await first).solverStats?.backend, "z3");
  client.terminate();
  assert.equal(worker.terminated, true);

  const throwing = new LoopZ3Client(() => ({
    postMessage() { throw new Error("clone failed"); },
    addEventListener() {}, removeEventListener() {}, terminate() {},
  }) as never);
  await assert.rejects(throwing.solve(model), /protocol failed/);

  const crashingWorker = new FakeWorker();
  const retryWorker = new FakeWorker();
  let crashFactoryCalls = 0;
  const crashing = new LoopZ3Client(() => (++crashFactoryCalls === 1 ? crashingWorker : retryWorker) as never);
  const crashed = crashing.solve(model);
  crashingWorker.crash();
  await assert.rejects(crashed, /Worker crashed/);
  assert.equal(crashingWorker.terminated, true);
  const retry = crashing.solve(model);
  retryWorker.respond({ type: "result", requestId: retryWorker.requests[0]!.requestId, result });
  assert.equal((await retry).solverStats?.backend, "z3");
  assert.equal(crashFactoryCalls, 2);
  crashing.terminate();

  let shouldThrowOnCreate = true;
  const createFailureWorker = new FakeWorker();
  const recoverableCreateFailure = new LoopZ3Client(() => {
    if (shouldThrowOnCreate) {
      shouldThrowOnCreate = false;
      throw new Error("constructor failed");
    }
    return createFailureWorker as never;
  });
  await assert.rejects(recoverableCreateFailure.solve(model), /Worker creation failed/);
  const recoveredCreate = recoverableCreateFailure.solve(model);
  createFailureWorker.respond({ type: "result", requestId: createFailureWorker.requests[0]!.requestId, result });
  assert.equal((await recoveredCreate).solverStats?.backend, "z3");
  recoverableCreateFailure.terminate();

  const silentWorker = new FakeWorker();
  const watchdogRetryWorker = new FakeWorker();
  let watchdogFactoryCalls = 0;
  const watchdogClient = new LoopZ3Client(() => (++watchdogFactoryCalls === 1 ? silentWorker : watchdogRetryWorker) as never, 5);
  await assert.rejects(watchdogClient.solve(model), /watchdog expired/);
  assert.equal(silentWorker.terminated, true);
  const watchdogRetry = watchdogClient.solve(model);
  watchdogRetryWorker.respond({ type: "result", requestId: watchdogRetryWorker.requests[0]!.requestId, result });
  assert.equal((await watchdogRetry).solverStats?.backend, "z3");
  assert.equal(watchdogFactoryCalls, 2);
  watchdogClient.terminate();

  const malformedWorker = new FakeWorker();
  const malformed = new LoopZ3Client(() => malformedWorker as never);
  const malformedRequest = malformed.solve(model);
  malformedWorker.respond({} as LoopWorkerResponse);
  await assert.rejects(malformedRequest, /malformed|requestId/);
  malformed.terminate();

  const messageErrorWorker = new FakeWorker();
  const messageErrorClient = new LoopZ3Client(() => messageErrorWorker as never);
  const messageErrorRequest = messageErrorClient.solve(model);
  messageErrorWorker.messageError();
  await assert.rejects(messageErrorRequest, /deserialized/);
  messageErrorClient.terminate();

  delete (globalThis as { Worker?: unknown }).Worker;
  await assert.rejects(new LoopZ3Client(() => { throw new Error("must not construct"); }).solve(model), /Worker API unavailable/);
  console.log(JSON.stringify({ status: "PASS", cases: ["success", "stale", "duplicate", "protocol-reject", "worker-crash-retry-same-client", "factory-throw-retry", "watchdog-reset-retry", "malformed", "messageerror", "no-worker-reject", "terminate"] }));
} finally {
  if (previousWorker === undefined) delete (globalThis as { Worker?: unknown }).Worker;
  else (globalThis as { Worker: unknown }).Worker = previousWorker;
}

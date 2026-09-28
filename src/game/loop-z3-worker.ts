import { init } from "z3-solver/build/browser";
import { LoopZ3UnsupportedError, createLoopZ3Session, solveLoopZ3 } from "./solver-loop-z3";
import { evaluateCompiledBoard } from "./solver";
import { solveLoop } from "./solver-loop";
import type { CompiledPuzzle } from "./solver-model";
import type { EvaluationResult } from "./types";
import type { LoopWorkerRequest, LoopWorkerResponse } from "./loop-z3-client";

declare const importScripts: (...urls: string[]) => void;
type BrowserApi = Awaited<ReturnType<typeof init>>;

let apiPromise: Promise<BrowserApi> | undefined;
// Only environment-wide inability to initialize Z3 is sticky. Unsupported
// rules and solve errors are request-local so a later supported request can
// still use the same warm Z3 runtime.
let environmentFallbackReason: string | undefined;

self.addEventListener("message", (event: MessageEvent<LoopWorkerRequest>) => {
  if (event.data?.type !== "solve") return;
  void solve(event.data);
});

async function solve(request: Extract<LoopWorkerRequest, { type: "solve" }>): Promise<void> {
  if (environmentFallbackReason) {
    postResult(request.requestId, legacyFallback(request.model, environmentFallbackReason));
    return;
  }
  if (typeof crossOriginIsolated === "undefined" || !crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
    environmentFallbackReason = "crossOriginIsolated/SharedArrayBuffer unavailable; used legacy fallback.";
    postResult(request.requestId, legacyFallback(request.model, environmentFallbackReason));
    return;
  }

  let api: BrowserApi;
  try {
    api = await initialize();
  } catch (error) {
    environmentFallbackReason = `Z3 asset/init failed: ${errorMessage(error)}`;
    postResult(request.requestId, legacyFallback(request.model, environmentFallbackReason));
    return;
  }

  try {
    const session = createLoopZ3Session(api, request.model);
    const z3 = await solveLoopZ3(session, request.model.timeBudgetMs);
    if (z3.classification === "timeout" || z3.classification === "unknown") {
      const reason = z3.unknownReason ? `Z3 ${z3.classification}: ${z3.unknownReason}` : `Z3 ${z3.classification}.`;
      const timeoutOutcome = { count: 0, timedOut: true, exploredNodes: z3.checks, elapsedMs: z3.elapsedMs, solutions: [] };
      postResult(request.requestId, evaluateCompiledBoard(request.model, timeoutOutcome, "z3", reason));
      return;
    }
    const outcome = { count: z3.signatures.length, timedOut: false, exploredNodes: z3.checks, elapsedMs: z3.elapsedMs, solutions: z3.solutions };
    postResult(request.requestId, evaluateCompiledBoard(request.model, outcome, "z3"));
  } catch (error) {
    if (error instanceof LoopZ3UnsupportedError) {
      postResult(request.requestId, legacyFallback(request.model, `Z3 unsupported active rule: ${error.message}`));
      return;
    }
    postResult(request.requestId, legacyFallback(request.model, `Z3 Worker solve/protocol failure: ${errorMessage(error)}`));
  }
}

async function initialize(): Promise<BrowserApi> {
  apiPromise ??= (async () => {
    ensureZ3GlobalAlias();
    const z3Built = new URL("../../assets/z3-built.js", self.location.href);
    importScripts(z3Built.href);
    return init({ locateFile: (file: string) => new URL(file, z3Built.href).href, mainScriptUrlOrBlob: z3Built.href });
  })();
  return apiPromise;
}

function ensureZ3GlobalAlias(): void {
  const runtimeGlobal = globalThis as typeof globalThis & { global?: typeof globalThis };
  runtimeGlobal.global ??= globalThis;
}

function legacyFallback(model: CompiledPuzzle, reason: string): EvaluationResult {
  return evaluateCompiledBoard(model, solveLoop(model), "legacy-fallback", reason);
}

function postResult(requestId: string, result: EvaluationResult): void {
  const message: LoopWorkerResponse = { type: "result", requestId, result };
  self.postMessage(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

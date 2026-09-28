import type { CompiledPuzzle } from "./solver-model";
import type { EvaluationResult } from "./types";

export type LoopWorkerRequest = { type: "solve"; requestId: string; model: CompiledPuzzle };
export type LoopWorkerResponse =
  | { type: "result"; requestId: string; result: EvaluationResult }
  | { type: "error"; requestId: string; message: string; diagnostic?: string };

type WorkerLike = {
  postMessage(message: LoopWorkerRequest): void;
  addEventListener(type: "message", listener: (event: MessageEvent<LoopWorkerResponse>) => void): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  addEventListener(type: "messageerror", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<LoopWorkerResponse>) => void): void;
  removeEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  removeEventListener(type: "messageerror", listener: (event: MessageEvent) => void): void;
  terminate(): void;
};

export type LoopWorkerFactory = () => WorkerLike;

export class LoopWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopWorkerError";
  }
}

/** Lazy, single-flight client for the production loop Worker. */
export class LoopZ3Client {
  private worker: WorkerLike | undefined;
  private sequence = 0;
  private pending: {
    requestId: string;
    resolve: (result: EvaluationResult) => void;
    reject: (error: Error) => void;
    onMessage: (event: MessageEvent<LoopWorkerResponse>) => void;
    onError: (event: ErrorEvent) => void;
    onMessageError: (event: MessageEvent) => void;
    watchdog: ReturnType<typeof setTimeout>;
  } | undefined;

  private readonly watchdogMs: number;

  constructor(
    private readonly createWorker: LoopWorkerFactory = () => new Worker(new URL("./loop-z3-worker.ts", import.meta.url)) as unknown as WorkerLike,
    watchdogMs = 15_000,
  ) {
    this.watchdogMs = Number.isFinite(watchdogMs) && watchdogMs > 0 ? watchdogMs : 15_000;
  }

  solve(model: CompiledPuzzle): Promise<EvaluationResult> {
    if (this.pending) return Promise.reject(new LoopWorkerError("LOOP_SOLVER_BUSY"));
    if (typeof Worker === "undefined") return Promise.reject(new LoopWorkerError("Worker API unavailable; retry or use a browser with Worker support."));

    let worker: WorkerLike;
    try {
      this.worker ??= this.createWorker();
      worker = this.worker;
    } catch (error) {
      this.worker = undefined;
      return Promise.reject(new LoopWorkerError(`Worker creation failed: ${errorMessage(error)}`));
    }

    const requestId = `loop-${++this.sequence}`;
    return new Promise<EvaluationResult>((resolve, reject) => {
      const onMessage = (event: MessageEvent<LoopWorkerResponse>) => {
        const message = event.data;
        if (!message || typeof message !== "object") {
          this.failRequest(worker, onMessage, onError, onMessageError, new LoopWorkerError("Worker returned a malformed response."));
          return;
        }
        if (typeof message.requestId !== "string") {
          this.failRequest(worker, onMessage, onError, onMessageError, new LoopWorkerError("Worker response omitted requestId."));
          return;
        }
        if (message.requestId !== requestId) return;
        if (message.type !== "result" && message.type !== "error") {
          this.failRequest(worker, onMessage, onError, onMessageError, new LoopWorkerError("Worker returned an unknown response type."));
          return;
        }
        if (message.type === "result" && (!message.result || typeof message.result !== "object")) {
          this.failRequest(worker, onMessage, onError, onMessageError, new LoopWorkerError("Worker result payload was malformed."));
          return;
        }
        if (message.type === "error" && typeof message.message !== "string") {
          this.failRequest(worker, onMessage, onError, onMessageError, new LoopWorkerError("Worker error payload was malformed."));
          return;
        }
        this.clearPending(worker, onMessage, onError, onMessageError);
        if (message.type === "result") resolve(message.result);
        else reject(new LoopWorkerError(message.diagnostic ? `${message.message} (${message.diagnostic})` : message.message));
      };
      const onError = (event: ErrorEvent) => {
        this.failRequest(worker, onMessage, onError, onMessageError, new LoopWorkerError(`Loop solver Worker crashed: ${event.message || "unknown error"}`));
      };
      const onMessageError = () => this.failRequest(worker, onMessage, onError, onMessageError, new LoopWorkerError("Loop solver Worker message could not be deserialized."));
      const watchdog = setTimeout(() => this.failRequest(worker, onMessage, onError, onMessageError, new LoopWorkerError("Loop solver Worker watchdog expired.")), this.watchdogMs);
      this.pending = { requestId, resolve, reject, onMessage, onError, onMessageError, watchdog };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.addEventListener("messageerror", onMessageError);
      try {
        worker.postMessage({ type: "solve", requestId, model });
      } catch (error) {
        this.failRequest(worker, onMessage, onError, onMessageError, new LoopWorkerError(`Worker protocol failed: ${errorMessage(error)}`));
      }
    });
  }

  terminate(): void {
    if (this.pending) {
      const pending = this.pending;
      this.clearPending(this.worker, pending.onMessage, pending.onError, pending.onMessageError);
      pending.reject(new LoopWorkerError("Loop solver Worker terminated."));
    }
    this.worker?.terminate();
    this.worker = undefined;
  }

  private failRequest(worker: WorkerLike, onMessage: (event: MessageEvent<LoopWorkerResponse>) => void, onError: (event: ErrorEvent) => void, onMessageError: (event: MessageEvent) => void, error: Error): void {
    const pending = this.pending;
    this.clearPending(worker, onMessage, onError, onMessageError);
    this.worker = undefined;
    worker.terminate();
    if (pending?.onMessage === onMessage) pending.reject(error);
  }

  private clearPending(worker: WorkerLike | undefined, onMessage: (event: MessageEvent<LoopWorkerResponse>) => void, onError: (event: ErrorEvent) => void, onMessageError: (event: MessageEvent) => void): void {
    worker?.removeEventListener("message", onMessage);
    worker?.removeEventListener("error", onError);
    worker?.removeEventListener("messageerror", onMessageError);
    if (this.pending?.onMessage === onMessage) {
      clearTimeout(this.pending.watchdog);
      this.pending = undefined;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

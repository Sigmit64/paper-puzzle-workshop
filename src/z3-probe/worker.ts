import { init } from "z3-solver/build/browser";

declare const importScripts: (...urls: string[]) => void;

type BrowserGlobal = typeof globalThis & { global?: typeof globalThis };

// The official browser.js wrapper reads `global.initZ3`. A classic worker has
// globalThis but does not guarantee Node's `global` alias, so provide the
// browser-global alias before the wrapper can be initialized.
const browserGlobal = globalThis as BrowserGlobal;
browserGlobal.global ??= globalThis;

type RunMessage = { type: "run" };

type ReadyMessage = { type: "ready" };

type ProbeResult = {
  type: "result";
  status: "PASS" | "FAIL_SOLVE" | "UNKNOWN";
  initMs: number;
  check1Ms: number;
  check2Ms: number;
  totalMs: number;
  firstCheck: string;
  secondCheck: string;
  answer: string;
  unknownReason?: string;
};

type ProbeError = {
  type: "error";
  status: "FAIL_ASSET" | "FAIL_INIT" | "FAIL_SOLVE" | "UNKNOWN";
  phase: string;
  message: string;
  unknownReason?: string;
};

self.addEventListener("message", (event: MessageEvent<RunMessage>) => {
  if (event.data?.type !== "run") return;
  void runProbe();
}, { once: true });

async function runProbe(): Promise<void> {
  const totalStart = performance.now();
  let api: Awaited<ReturnType<typeof init>> | undefined;
  const z3Built = new URL("./z3-built.js", self.location.href);
  try {
    // z3-built.js is intentionally a classic script in the official package.
    // Vite emits this worker as a classic IIFE so importScripts is available.
    importScripts(z3Built.href);
    self.postMessage({ type: "ready" } satisfies ReadyMessage);
  } catch (error) {
    postError("FAIL_ASSET", "asset", error);
    return;
  }

  let initStart = performance.now();
  try {
    // In an application worker `self.location` points at Vite's worker
    // chunk, not at the package-owned classic script. The probe worker and
    // official assets are deliberately co-located inside the service-worker
    // scope, so anchor Emscripten's URLs to that shared directory.
    api = await init({
      locateFile: (file: string) => new URL(file, z3Built.href).href,
      mainScriptUrlOrBlob: z3Built.href,
    });
  } catch (error) {
    postError("FAIL_INIT", "init", error);
    return;
  }
  const initMs = performance.now() - initStart;

  try {
    const { Context } = api;
    const { Int, Or, Solver } = new Context("z3-pages-probe");
    const x = Int.const("x");
    const y = Int.const("y");
    const solver = new Solver();
    solver.add(x.ge(0), x.le(1), y.ge(0), y.le(1), x.eq(0), y.eq(1));

    const check1Start = performance.now();
    const firstCheck = await solver.check();
    const check1Ms = performance.now() - check1Start;
    if (firstCheck === "unknown") {
      postResult({
        status: "UNKNOWN", initMs, check1Ms, check2Ms: 0, totalMs: performance.now() - totalStart,
        firstCheck, secondCheck: "not-run", answer: "not available", unknownReason: solver.reasonUnknown(),
      });
      return;
    }
    if (firstCheck !== "sat") {
      postResult({
        status: "FAIL_SOLVE", initMs, check1Ms, check2Ms: 0, totalMs: performance.now() - totalStart,
        firstCheck, secondCheck: "not-run", answer: "not available",
      });
      return;
    }

    const model = solver.model();
    const answerX = (model.get(x) as unknown as { value(): bigint }).value();
    const answerY = (model.get(y) as unknown as { value(): bigint }).value();
    const answer = `x=${answerX.toString()}, y=${answerY.toString()}`;
    solver.add(Or(x.neq(answerX), y.neq(answerY)));

    const check2Start = performance.now();
    const secondCheck = await solver.check();
    const check2Ms = performance.now() - check2Start;
    const unknownReason = secondCheck === "unknown" ? solver.reasonUnknown() : undefined;
    const status = secondCheck === "unsat" ? "PASS" : secondCheck === "unknown" ? "UNKNOWN" : "FAIL_SOLVE";
    postResult({
      status, initMs, check1Ms, check2Ms, totalMs: performance.now() - totalStart,
      firstCheck, secondCheck, answer, unknownReason,
    });
  } catch (error) {
    postError("FAIL_SOLVE", "solve", error);
  }
}

function postResult(result: Omit<ProbeResult, "type">): void {
  self.postMessage({ type: "result", ...result });
}

function postError(status: ProbeError["status"], phase: string, error: unknown): void {
  self.postMessage({ type: "error", status, phase, message: error instanceof Error ? error.message : String(error) });
}

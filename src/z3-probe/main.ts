import "./probe.css";
import { createLoopZ3BenchmarkFixture } from "../game/loop-z3-fixture";
import { validateLoopSolution } from "../game/loop-pilot-validator";
import type { LoopZ3Client } from "../game/loop-z3-client";

type ProbeStatus = "PASS" | "BLOCKED_HEADERS" | "FAIL_ASSET" | "FAIL_INIT" | "FAIL_SOLVE" | "UNKNOWN" | "NOT_RUN";

type ProbeResult = {
  type: "result";
  status: Exclude<ProbeStatus, "NOT_RUN" | "BLOCKED_HEADERS" | "FAIL_ASSET" | "FAIL_INIT">;
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

type WorkerMessage = ProbeResult | ProbeError;
type WorkerReady = { type: "ready" };
type WorkerEvent = WorkerMessage | WorkerReady;

const root = document.querySelector<HTMLElement>("#z3-probe-root");
if (!root) throw new Error("Z3 probe root is missing");

const yesNo = (value: boolean): string => (value ? "true" : "false");
const isSecure = window.isSecureContext;
const isIsolated = window.crossOriginIsolated === true;
const hasSharedArrayBuffer = typeof window.SharedArrayBuffer !== "undefined";
const hasWebAssembly = typeof window.WebAssembly !== "undefined";
const hasWorker = typeof window.Worker !== "undefined";
const hasServiceWorker = "serviceWorker" in navigator;
const serviceWorkerControlled = navigator.serviceWorker?.controller !== null;
const currentUrl = new URL(window.location.href);
const basePath = currentUrl.pathname.endsWith("/") ? currentUrl.pathname : `${currentUrl.pathname}/`;

root.innerHTML = `
  <article class="probe-card">
    <p class="eyebrow">Experimental compatibility spike</p>
    <h1>Official Z3 on GitHub Pages</h1>
    <p class="lede">This page is isolated from the game. It loads <code>z3-solver@5.2.0</code> only after you click the button.</p>
    <section class="capabilities" aria-labelledby="capabilities-title">
      <h2 id="capabilities-title">Browser capabilities</h2>
      <dl>
        <div><dt>isSecureContext</dt><dd>${yesNo(isSecure)}</dd></div>
        <div><dt>crossOriginIsolated</dt><dd>${yesNo(isIsolated)}</dd></div>
        <div><dt>SharedArrayBuffer</dt><dd>${yesNo(hasSharedArrayBuffer)}</dd></div>
        <div><dt>WebAssembly</dt><dd>${yesNo(hasWebAssembly)}</dd></div>
        <div><dt>Worker</dt><dd>${yesNo(hasWorker)}</dd></div>
        <div><dt>ServiceWorker</dt><dd>${yesNo(hasServiceWorker)}</dd></div>
        <div><dt>ServiceWorker controlled</dt><dd>${yesNo(serviceWorkerControlled)}</dd></div>
        <div><dt>Vite base URL</dt><dd><code>${escapeHtml(import.meta.env.BASE_URL)}</code></dd></div>
        <div><dt>current path</dt><dd><code>${escapeHtml(`${basePath} (${currentUrl.origin})`)}</code></dd></div>
      </dl>
    </section>
    <p id="header-warning" class="warning"></p>
    <button id="run-probe" type="button">Run Z3 probe</button>
    <output id="probe-output" class="result" aria-live="polite">
      <strong>Status: NOT_RUN</strong>
      <span>Click to lazily initialize Z3 and run the finite-domain uniqueness check.</span>
    </output>
    <hr />
    <button id="run-production-loop" type="button">Run production 8×8 loop smoke</button>
    <output id="production-loop-output" class="result" aria-live="polite"><strong>Production loop: NOT_RUN</strong><span>This uses the same lazy Worker/client and full 46-rule encoder as game loop submission.</span></output>
    <p class="notes">A PASS requires a secure, cross-origin-isolated context and SAT → blocking UNSAT. GitHub Pages does not emit COOP/COEP itself, so the root-scope service worker adds them after an automatic first-load reload. Licenses: <a href="../assets/Z3-LICENSE.txt">Z3 MIT</a> · <a href="../COI-SERVICEWORKER-LICENSE.txt">COI service worker MIT</a>.</p>
  </article>
`;

const warning = document.querySelector<HTMLElement>("#header-warning");
if (warning && (!isSecure || !isIsolated || !hasSharedArrayBuffer)) {
  warning.textContent = "BLOCKED_HEADERS: this browser is not cross-origin isolated after the probe service worker registration attempt. The official threaded WASM package cannot be initialized in this browser/session.";
}

const output = document.querySelector<HTMLOutputElement>("#probe-output");
const button = document.querySelector<HTMLButtonElement>("#run-probe");
const productionButton = document.querySelector<HTMLButtonElement>("#run-production-loop");
const productionOutput = document.querySelector<HTMLOutputElement>("#production-loop-output");
if (!output || !button || !productionButton || !productionOutput) throw new Error("Z3 probe controls are missing");

const productionFixture = createLoopZ3BenchmarkFixture(2500);
let productionClient: LoopZ3Client | undefined;
let productionRuns = 0;

productionButton.addEventListener("click", async () => {
  productionButton.disabled = true;
  const run = ++productionRuns;
  const started = performance.now();
  productionOutput.innerHTML = `<strong>Production loop: RUNNING ${run}</strong><span>Compiling and solving the fixed 8×8 fixture in the production Worker…</span>`;
  try {
    productionClient ??= new (await import("../game/loop-z3-client")).LoopZ3Client();
    const result = await productionClient.solve(productionFixture);
    const validations = (result.solutions ?? []).map((solution) => validateLoopSolution(productionFixture, solution.loop ?? []).valid);
    const valid = result.status === "multiple" && validations.length === 2 && validations.every(Boolean);
    productionOutput.dataset.status = valid ? "PASS" : "FAIL";
    productionOutput.dataset.backend = result.solverStats?.backend ?? "unknown";
    productionOutput.dataset.run = String(run);
    productionOutput.innerHTML = `<strong>Production loop: ${valid ? "PASS" : "FAIL"}</strong><span>Run ${run}: ${escapeHtml(result.status)} · backend=${escapeHtml(result.solverStats?.backend ?? "unknown")} · solutions=${validations.length} · elapsed=${(performance.now() - started).toFixed(1)} ms</span>${result.solverStats?.diagnostic ? `<span>${escapeHtml(result.solverStats.diagnostic)}</span>` : ""}`;
  } catch (error) {
    productionOutput.dataset.status = "ERROR";
    productionOutput.dataset.run = String(run);
    productionOutput.innerHTML = `<strong>Production loop: ERROR</strong><span>${escapeHtml(errorMessage(error))}</span>`;
  } finally {
    productionButton.disabled = false;
  }
});
window.addEventListener("beforeunload", () => productionClient?.terminate(), { once: true });

let worker: Worker | undefined;
let workerReady = false;

button.addEventListener("click", () => {
  button.disabled = true;
  output.innerHTML = "<strong>Status: RUNNING</strong><span>Loading the official package in an application worker…</span>";

  if (!isSecure || !isIsolated || !hasSharedArrayBuffer) {
    output.innerHTML = `<strong>Status: BLOCKED_HEADERS</strong><span>${escapeHtml(headerMessage())}</span>`;
    button.disabled = false;
    return;
  }
  if (!hasWebAssembly || !hasWorker) {
    output.innerHTML = "<strong>Status: FAIL_ASSET</strong><span>WebAssembly or Worker is unavailable in this browser.</span>";
    button.disabled = false;
    return;
  }

  try {
    workerReady = false;
    worker = new Worker(new URL("./worker.ts", import.meta.url));
    worker.addEventListener("message", (event: MessageEvent<WorkerEvent>) => {
      if (event.data.type === "ready") {
        workerReady = true;
        output.innerHTML = "<strong>Status: RUNNING</strong><span>Official Z3 asset loaded; initializing the threaded WASM runtime…</span>";
        return;
      }
      renderMessage(event.data);
      worker?.terminate();
      worker = undefined;
      button.disabled = false;
    });
    worker.addEventListener("error", (event) => {
      const status = workerReady ? "FAIL_INIT" : "FAIL_ASSET";
      output.innerHTML = `<strong>Status: ${status}</strong><span>${escapeHtml(event.message || "The probe worker failed before returning a result.")}</span>`;
      worker?.terminate();
      worker = undefined;
      button.disabled = false;
    }, { once: true });
    worker.postMessage({ type: "run" });
  } catch (error) {
    output.innerHTML = `<strong>Status: FAIL_INIT</strong><span>${escapeHtml(errorMessage(error))}</span>`;
    button.disabled = false;
  }
});

function renderMessage(message: WorkerMessage): void {
  if (message.type === "error") {
    const reason = message.unknownReason ? ` Unknown reason: ${message.unknownReason}` : "";
    output!.innerHTML = `<strong>Status: ${message.status}</strong><span>Phase: ${escapeHtml(message.phase)}. ${escapeHtml(message.message)}${escapeHtml(reason)}</span>`;
    return;
  }
  const reason = message.unknownReason ? `<span>Unknown reason: ${escapeHtml(message.unknownReason)}</span>` : "";
  output!.innerHTML = `
    <strong>Status: ${message.status}</strong>
    <span>First check: ${escapeHtml(message.firstCheck)}; second check after blocking: ${escapeHtml(message.secondCheck)}.</span>
    <span>Canonical projection: <code>${escapeHtml(message.answer)}</code></span>
    <span>Initialization: ${message.initMs.toFixed(1)} ms · check 1: ${message.check1Ms.toFixed(1)} ms · check 2: ${message.check2Ms.toFixed(1)} ms · total: ${message.totalMs.toFixed(1)} ms</span>
    ${reason}
  `;
}

function headerMessage(): string {
  return `isSecureContext=${yesNo(isSecure)}, crossOriginIsolated=${yesNo(isIsolated)}, SharedArrayBuffer=${yesNo(hasSharedArrayBuffer)}. The official z3-solver package requires SharedArrayBuffer plus COOP/COEP headers for its threaded WASM runtime.`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

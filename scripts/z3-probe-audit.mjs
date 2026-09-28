import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, relative } from "node:path";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const dist = resolve("dist");
const probeHtmlPath = resolve(dist, "z3-probe/index.html");
assert.ok(existsSync(probeHtmlPath), "dist/z3-probe/index.html is missing");

const z3Js = resolve(dist, "assets/z3-built.js");
const z3Wasm = resolve(dist, "assets/z3-built.wasm");
const z3License = resolve(dist, "assets/Z3-LICENSE.txt");
const coiServiceWorker = resolve(dist, "coi-serviceworker.js");
const coiBootstrap = resolve(dist, "coi-bootstrap.js");
const coiLicense = resolve(dist, "COI-SERVICEWORKER-LICENSE.txt");
assert.ok(existsSync(z3Js), "official z3-built.js asset is missing");
assert.ok(existsSync(z3Wasm), "official z3-built.wasm asset is missing");
assert.ok(existsSync(z3License), "Z3 license asset is missing");
assert.ok(existsSync(coiServiceWorker), "COI service worker asset is missing");
assert.ok(existsSync(coiBootstrap), "COI page bootstrap asset is missing");
assert.ok(existsSync(coiLicense), "COI service worker license is missing");
assert.ok(statSync(z3Wasm).size > 100_000, "z3-built.wasm is unexpectedly small");
const z3Text = readFileSync(z3Js, "utf8");
assert.match(z3Text, /var initZ3\s*=|function initZ3/, "z3-built.js is not the official initializer shape");
assert.match(z3Text, /z3-built\.wasm/, "z3-built.js does not reference its WASM companion");
assert.equal(
  readFileSync(z3License, "utf8"),
  readFileSync(require.resolve("z3-solver/LICENSE.txt"), "utf8"),
  "dist Z3 license does not match the installed official package",
);
assert.equal(
  readFileSync(coiServiceWorker, "utf8"),
  readFileSync(require.resolve("coi-serviceworker/coi-serviceworker.min.js"), "utf8"),
  "dist COI service worker does not match the pinned package",
);
assert.equal(
  readFileSync(coiLicense, "utf8"),
  readFileSync(require.resolve("coi-serviceworker/LICENSE"), "utf8"),
  "dist COI service worker license does not match the pinned package",
);
assert.equal(
  readFileSync(coiBootstrap, "utf8"),
  readFileSync(resolve(process.cwd(), "coi-bootstrap.js"), "utf8"),
  "dist COI page bootstrap does not match the audited source",
);
const coiBootstrapText = readFileSync(coiBootstrap, "utf8");
assert.doesNotMatch(coiBootstrapText, /navigator\.serviceWorker\.register\s*=|Object\.defineProperty\s*\(\s*navigator\.serviceWorker/, "COI bootstrap patches the native registration API");
assert.match(coiBootstrapText, /let reloadRequested\s*=\s*false/);
assert.match(coiBootstrapText, /if \(reloadRequested\) return/);
await auditBootstrapReloadIdempotence(coiBootstrapText);

const html = readFileSync(probeHtmlPath, "utf8");
assert.match(html, /coi-bootstrap\.js/, "probe HTML does not load the root COI bootstrap");
const htmlRefs = [...html.matchAll(/<(script|link)\b([^>]*)>/g)]
  .map((match) => {
    const attributes = match[2];
    const url = attributes.match(/(?:src|href)="([^"]+)"/)?.[1];
    return { tag: match[1], raw: url, rel: attributes.match(/rel="([^"]+)"/)?.[1] };
  })
  .filter(({ raw }) => raw && !raw.startsWith("data:"));
assert.ok(htmlRefs.some(({ tag }) => tag === "script"), "probe HTML has no module script");
assert.ok(htmlRefs.some(({ tag, rel }) => tag === "link" && rel === "stylesheet"), "probe HTML has no CSS link");
assert.ok(htmlRefs.some(({ tag, rel }) => tag === "link" && rel === "modulepreload"), "probe HTML has no modulepreload link");

const chains = [];
for (const mount of ["/", "/repo/"]) {
  const htmlUrl = `https://example.test${mount}z3-probe/index.html`;
  const resolvedRefs = htmlRefs.map(({ tag, raw }) => ({ tag, raw, ...assertDistUrl(raw, htmlUrl, mount, "probe HTML") }));
  const coiRef = resolvedRefs.find(({ raw }) => raw.endsWith("coi-bootstrap.js"));
  assert.ok(coiRef, `${mount} probe HTML does not load the COI page bootstrap`);
  assert.equal(coiRef.file, coiBootstrap, `${mount} probe HTML points at the wrong COI bootstrap`);
  assert.ok(!resolvedRefs.some(({ raw }) => raw.endsWith("coi-serviceworker.js")), `${mount} probe HTML must not execute the Service Worker script as page code`);
  assert.ok(!resolvedRefs.some(({ url }) => /main-[A-Za-z0-9_-]+\.js$/.test(url.pathname)), `${mount} probe statically loads the game main entry`);
  const uiRef = resolvedRefs.find(({ tag, file }) => tag === "script" && readFileSync(file, "utf8").includes("Experimental compatibility spike"));
  assert.ok(uiRef, `${mount} probe UI module is missing from the HTML reference chain`);
  const uiText = readFileSync(uiRef.file, "utf8");
  assert.doesNotMatch(uiText, /createRoot|game-shell/, `${mount} probe entry is coupled to the React game entry`);
  assert.match(uiText, /new Worker/, `${mount} probe UI does not create a worker lazily`);

  const workerRefs = [...uiText.matchAll(/[`"']((?:\.\.?\/)*(?:[^`"']+\/)*worker-[A-Za-z0-9_-]+\.js)[`"']/g)].map((match) => match[1]);
  assert.equal(new Set(workerRefs).size, 1, `${mount} UI must contain exactly one application worker URL`);
  const workerRef = workerRefs[0];
  const worker = assertDistUrl(workerRef, uiRef.url, mount, `${mount} UI → application worker`);
  assert.ok(worker.url.pathname.startsWith(`${mount}z3-probe/`), `${mount} application worker escapes the probe service-worker scope`);
  assert.ok(!worker.file.endsWith("z3-built.js"), "z3-built.js was incorrectly identified as the application worker");
  const workerText = readFileSync(worker.file, "utf8");
  assert.match(workerText, /z3-built\.js/, `${mount} application worker does not reference z3-built.js`);
  assert.match(workerText, /locateFile/, `${mount} application worker does not anchor the WASM locateFile URL`);
  assert.match(workerText, /mainScriptUrlOrBlob/, `${mount} application worker does not wire mainScriptUrlOrBlob for pthreads`);

  const z3RefMatch = workerText.match(/[`"']((?:\.\.?\/)?(?:[^`"']+\/)*z3-built\.js)[`"']/);
  assert.ok(z3RefMatch, `${mount} application worker has no auditable z3-built.js URL`);
  const z3Ref = assertDistUrl(z3RefMatch[1], worker.url, mount, `${mount} worker → z3-built.js`);
  assert.equal(z3Ref.file, z3Js, `${mount} worker points at the wrong z3-built.js file`);

  const simulation = await simulateWorker(workerText, worker.url.href, z3Ref.url.href);
  assert.equal(simulation.loadedScriptUrl, z3Ref.url.href, `${mount} VM loaded the wrong z3-built.js URL`);
  assert.ok(simulation.ready, `${mount} VM did not receive the ready message`);
  assert.equal(simulation.error.status, "FAIL_INIT", `${mount} VM did not classify the init stub as FAIL_INIT`);
  assert.match(simulation.error.message, /^Error: audit stub$/, `${mount} VM error was not the expected audit stub`);
  assert.doesNotMatch(simulation.error.message, /global is not defined/, `${mount} VM hit a missing global alias`);
  assert.equal(simulation.overrides.mainScriptUrlOrBlob, z3Ref.url.href, `${mount} VM mainScriptUrlOrBlob is wrong`);
  assert.equal(simulation.overrides.locateFile("z3-built.wasm", "ignored"), new URL("z3-built.wasm", z3Ref.url.href).href, `${mount} VM locateFile returned the wrong WASM URL`);

  if (mount === "/") {
    const alias = workerText.match(/let ([A-Za-z_$][\w$]*)=globalThis;\1\.global\?\?=globalThis,/);
    assert.ok(alias, "worker global alias wiring was not emitted in an auditable form");
    const negative = await simulateWorker(workerText.replace(alias[0], ""), worker.url.href, z3Ref.url.href);
    assert.ok(negative.ready, "negative worker VM did not reach ready before init");
    assert.match(negative.error.message, /global is not defined/, "negative worker VM did not catch removal of the global alias");
  }

  chains.push({
    mount,
    html: relative(process.cwd(), probeHtmlPath),
    htmlAssets: resolvedRefs.map(({ tag, url }) => `${tag}:${url.pathname}`),
    uiModule: relative(process.cwd(), uiRef.file),
    cssAndModulepreload: resolvedRefs.filter(({ tag }) => tag === "link").map(({ url }) => url.pathname),
    applicationWorker: relative(process.cwd(), worker.file),
    z3Built: relative(process.cwd(), z3Js),
    wasm: relative(process.cwd(), z3Wasm),
  });
}

const gameHtml = readFileSync(resolve(dist, "index.html"), "utf8");
assert.match(gameHtml, /coi-bootstrap\.js/, "normal game HTML does not load the root COI bootstrap");
assert.match(gameHtml, /rel="icon"/, "normal game HTML has no favicon data URL");
const gameHtmlRefs = [...gameHtml.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]);
assert.ok(gameHtmlRefs.some((source) => source.endsWith("coi-bootstrap.js")), "normal game HTML does not load the root-scope COI bootstrap");
assert.ok(!gameHtmlRefs.some((source) => source.endsWith("coi-serviceworker.js")), "normal game HTML must not execute the Service Worker script as page code");
assert.doesNotMatch(gameHtml, /z3-built|z3-solver|loop-z3-client|loop-z3-worker/, "normal game HTML eagerly references the Z3 or loop Worker assets");
assert.ok(gameHtmlRefs.every((source) => source.endsWith("coi-bootstrap.js") || !source.includes("z3-built")), "normal game HTML directly references Z3 assets");
assert.ok(statSync(coiBootstrap).size < 4_000, "root COI bootstrap is not a small first-load shim");
for (const source of [...gameHtml.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1])) {
  const gameScript = readFileSync(resolve(dist, `.${new URL(source, "https://example.test/").pathname}`), "utf8");
  assert.doesNotMatch(gameScript, /z3-built|z3-pages-probe|z3-solver|createLoopZ3Session/, "game entry bundle contains Z3 implementation code");
}
const gameModuleRef = gameHtmlRefs.find((source) => !source.endsWith("coi-bootstrap.js"));
assert.ok(gameModuleRef, "normal game module is missing");
const gameScript = readFileSync(resolve(dist, `.${new URL(gameModuleRef, "https://example.test/").pathname}`), "utf8");
const loopClientName = readdirSync(resolve(dist, "assets")).find((name) => /^loop-z3-client-[A-Za-z0-9_-]+\.js$/.test(name));
assert.ok(loopClientName, "lazy loop client chunk is missing");
const loopClientText = readFileSync(resolve(dist, "assets", loopClientName), "utf8");
assert.doesNotMatch(loopClientText, /solveLoop|evaluateCompiledBoard|legacy-fallback/, "main-thread loop client contains a synchronous legacy fallback");
const loopWorkerRefs = [...loopClientText.matchAll(/[`"']((?:\.\.?\/)*(?:[^`"']+\/)*loop-z3-worker-[A-Za-z0-9_-]+\.js)[`"']/g)].map((match) => match[1]);
assert.equal(new Set(loopWorkerRefs).size, 1, "normal game must contain one lazy loop Worker URL");
const loopWorker = assertDistUrl(loopWorkerRefs[0], new URL(`https://example.test/assets/${loopClientName}`), "/", "normal game → loop Worker");
const loopWorkerText = readFileSync(loopWorker.file, "utf8");
assert.match(loopWorkerText, /LoopZ3|loop-z3/, "loop Worker does not use the full Z3 encoder");
assert.match(loopWorkerText, /legacy-fallback|crossOriginIsolated/, "loop Worker has no observable legacy fallback path");
assert.match(loopWorkerText, /z3-built\.js/, "loop Worker does not lazily reference the Z3 asset");
const productionAlias = loopWorkerText.match(/([A-Za-z_$][\w$]*)\.global\?\?=globalThis/);
assert.ok(productionAlias, "production loop Worker is missing the global alias before browser Z3 init");
const productionVm = await simulateProductionWorker(loopWorkerText, false);
assert.equal(productionVm.status, "result", "production loop Worker VM did not return a structured result");
assert.match(productionVm.diagnostic, /asset\/init failed|legacy-fallback/, "production loop Worker VM did not classify init fallback");
const productionVmMutation = await simulateProductionWorker(loopWorkerText.replace(productionAlias[0], ""), true);
assert.equal(productionVmMutation.status, "result", "mutated production Worker did not return a result");
assert.match(productionVmMutation.diagnostic, /global is not defined/, "deleting production Worker global alias did not break the init wiring");

const appWorkerBytes = statSync(resolve(process.cwd(), chains[0].applicationWorker)).size;
console.log(JSON.stringify({
  status: "PASS",
  chains,
  z3WasmBytes: statSync(z3Wasm).size,
  z3JsBytes: statSync(z3Js).size,
  appWorkerBytes,
}));

function assertDistUrl(raw, baseUrl, mount, label) {
  const url = new URL(raw, baseUrl);
  assert.equal(url.origin, "https://example.test", `${label} escapes the audited origin`);
  assert.ok(url.pathname.startsWith(mount), `${label} escapes the ${mount} mount`);
  const relativeUrl = url.pathname.slice(mount.length);
  const file = resolve(dist, relativeUrl);
  assert.ok(file.startsWith(`${dist}/`), `${label} resolves outside dist`);
  assert.ok(existsSync(file) && statSync(file).isFile(), `${label} URL does not resolve to a file: ${url.pathname}`);
  return { url, file };
}

async function auditBootstrapReloadIdempotence(source) {
  const listeners = new Map();
  let reloads = 0;
  const serviceWorker = {
    controller: null,
    register: () => Promise.resolve({ active: {}, installing: null, waiting: null }),
    addEventListener: (type, callback) => listeners.set(type, callback),
  };
  const sandbox = {
    URL,
    document: { currentScript: { src: "https://example.test/repo/coi-bootstrap.js" }, baseURI: "https://example.test/repo/" },
    location: { pathname: "/repo/", reload: () => { reloads += 1; } },
    navigator: { serviceWorker },
    window: { crossOriginIsolated: false },
    sessionStorage: { getItem: () => { throw new Error("storage blocked"); }, setItem: () => { throw new Error("storage blocked"); } },
    Promise,
  };
  runInNewContext(source, sandbox, { filename: "coi-bootstrap-audit.js" });
  await Promise.resolve();
  listeners.get("controllerchange")?.();
  await Promise.resolve();
  assert.equal(reloads, 1, "active and controllerchange notifications must trigger exactly one reload when storage is unavailable");
  assert.equal(serviceWorker.register.name, "register", "audit fixture must expose the native registration shape");
}

async function simulateWorker(source, workerHref, expectedZ3Url) {
  const messages = [];
  let onMessage;
  let loadedScriptUrl;
  let overrides;
  const sandbox = {
    URL,
    performance,
    Promise,
    setTimeout,
    clearTimeout,
    location: { href: workerHref },
    postMessage: (message) => messages.push(message),
    addEventListener: (type, callback) => { if (type === "message") onMessage = callback; },
    importScripts: (url) => {
      loadedScriptUrl = url;
      sandbox.initZ3 = (nextOverrides) => {
        overrides = nextOverrides;
        return Promise.reject(new Error("audit stub"));
      };
    },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  runInNewContext(source, sandbox, { filename: "probe-worker-audit.js" });
  assert.equal(typeof onMessage, "function", "worker simulation did not register its message handler");
  await onMessage({ data: { type: "run" } });
  await new Promise((resolveMessage) => setTimeout(resolveMessage, 0));
  const error = messages.find((message) => message.type === "error");
  assert.ok(error, "worker simulation did not return an error message");
  return {
    loadedScriptUrl,
    ready: messages.some((message) => message.type === "ready"),
    error,
    overrides,
    expectedZ3Url,
  };
}

async function simulateProductionWorker(source, mutated) {
  const messages = [];
  let handler;
  const sandbox = {
    URL,
    performance,
    Promise,
    setTimeout,
    clearTimeout,
    SharedArrayBuffer,
    crossOriginIsolated: true,
    location: { href: "https://example.test/z3-probe/assets/loop-z3-worker.js" },
    postMessage: (message) => messages.push(message),
    addEventListener: (type, callback) => { if (type === "message") handler = callback; },
    importScripts: () => {
      if (mutated && !sandbox.global) throw new Error("global is not defined");
      sandbox.initZ3 = () => Promise.reject(new Error("audit init stub"));
    },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  runInNewContext(source, sandbox, { filename: "production-loop-worker-audit.js" });
  const model = {
    board: { id: "audit", name: "audit", rows: 2, columns: 2, activeCells: ["0:0", "0:1", "1:0", "1:1"], ruleCapacity: 4, mechanic: "loop", globalCards: [], clueCards: [], clues: [], draftStrokes: [], revision: 0 },
    mechanic: "loop",
    globalRuleKeys: ["loop.single-cycle"],
    clueRules: [],
    solutionLimit: 1,
    timeBudgetMs: 100,
  };
  assert.equal(typeof handler, "function", "production loop Worker VM did not register a message handler");
  await handler({ data: { type: "solve", requestId: "audit-1", model } });
  await new Promise((resolveMessage) => setTimeout(resolveMessage, 0));
  const result = messages.find((message) => message.type === "result");
  assert.ok(result, "production loop Worker VM emitted no result");
  return { status: result.type, diagnostic: result.result?.solverStats?.diagnostic ?? "" };
}

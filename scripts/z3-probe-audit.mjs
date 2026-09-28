import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, relative } from "node:path";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const dist = resolve("dist");
const probeHtmlPath = resolve(dist, "z3-probe/index.html");
assert.ok(existsSync(probeHtmlPath), "dist/z3-probe/index.html is missing");

const z3Js = resolve(dist, "z3-probe/assets/z3-built.js");
const z3Wasm = resolve(dist, "z3-probe/assets/z3-built.wasm");
const z3License = resolve(dist, "z3-probe/assets/Z3-LICENSE.txt");
assert.ok(existsSync(z3Js), "official z3-built.js asset is missing");
assert.ok(existsSync(z3Wasm), "official z3-built.wasm asset is missing");
assert.ok(existsSync(z3License), "Z3 license asset is missing");
assert.ok(statSync(z3Wasm).size > 100_000, "z3-built.wasm is unexpectedly small");
const z3Text = readFileSync(z3Js, "utf8");
assert.match(z3Text, /var initZ3\s*=|function initZ3/, "z3-built.js is not the official initializer shape");
assert.match(z3Text, /z3-built\.wasm/, "z3-built.js does not reference its WASM companion");
assert.equal(
  readFileSync(z3License, "utf8"),
  readFileSync(require.resolve("z3-solver/LICENSE.txt"), "utf8"),
  "dist Z3 license does not match the installed official package",
);

const html = readFileSync(probeHtmlPath, "utf8");
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
  const uiRef = resolvedRefs.find(({ tag, file }) => tag === "script" && readFileSync(file, "utf8").includes("Experimental compatibility spike"));
  assert.ok(uiRef, `${mount} probe UI module is missing from the HTML reference chain`);
  const uiText = readFileSync(uiRef.file, "utf8");
  assert.match(uiText, /new Worker/, `${mount} probe UI does not create a worker lazily`);

  const workerRefs = [...uiText.matchAll(/[`"']((?:\.\.?\/)?worker-[A-Za-z0-9_-]+\.js)[`"']/g)].map((match) => match[1]);
  assert.equal(new Set(workerRefs).size, 1, `${mount} UI must contain exactly one application worker URL`);
  const workerRef = workerRefs[0];
  const worker = assertDistUrl(workerRef, uiRef.url, mount, `${mount} UI → application worker`);
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
for (const source of [...gameHtml.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1])) {
  const gameScript = readFileSync(resolve(dist, `.${new URL(source, "https://example.test/").pathname}`), "utf8");
  assert.doesNotMatch(gameScript, /z3-built|z3-pages-probe|z3-solver/, "game entry bundle contains probe/Z3 code");
}

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

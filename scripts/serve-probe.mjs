import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { createServer } from "node:http";

const root = resolve("dist");
const portArgument = process.argv.find((argument) => argument.startsWith("--port="));
const port = Number(portArgument?.slice("--port=".length) ?? 4173);
const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

const server = createServer((request, response) => {
  const requestPath = decodeURIComponent((request.url ?? "/").split("?", 1)[0]);
  const mountedPath = requestPath.startsWith("/repo/") ? requestPath.slice("/repo".length) : requestPath;
  const relativePath = mountedPath === "/"
    ? "index.html"
    : `${mountedPath.replace(/^\/+/, "")}${mountedPath.endsWith("/") ? "index.html" : ""}`;
  const file = normalize(join(root, relativePath));
  if (!file.startsWith(`${root}/`)) {
    response.writeHead(403).end("forbidden");
    return;
  }
  let stat;
  try { stat = statSync(file); } catch { response.writeHead(404).end("not found"); return; }
  if (!stat.isFile()) { response.writeHead(404).end("not found"); return; }
  response.writeHead(200, {
    "Content-Type": types[extname(file)] ?? "application/octet-stream",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cache-Control": "no-store",
  });
  createReadStream(file).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Serving ${root} with COOP/COEP at http://127.0.0.1:${port}/ (Ctrl-C to stop)`);
});

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";

const output = mkdtempSync(join(tmpdir(), "ppd-loop-client-"));
try {
  await build({ logLevel: "silent", build: { ssr: "scripts/loop-z3-client-test-entry.ts", outDir: output, emptyOutDir: true } });
  const entry = readdirSync(output).find((name) => name === "loop-z3-client-test-entry.js");
  if (!entry) throw new Error("Loop client test build did not produce an entry");
  await import(pathToFileURL(join(output, entry)).href);
} finally {
  rmSync(output, { recursive: true, force: true });
}

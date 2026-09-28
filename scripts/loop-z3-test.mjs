import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";

const output = mkdtempSync(join(process.cwd(), ".loop-z3-test-"));
try {
  await build({
    logLevel: "silent",
    build: { ssr: "scripts/loop-z3-test-entry.ts", outDir: output, emptyOutDir: true },
  });
  const entry = readdirSync(output).find((name) => name === "loop-z3-test-entry.js");
  if (!entry) throw new Error("Loop Z3 test build did not produce an entry");
  await import(pathToFileURL(join(output, entry)).href);
} finally {
  rmSync(output, { recursive: true, force: true });
}

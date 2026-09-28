import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const require = createRequire(import.meta.url);

/**
 * z3-solver's browser build deliberately keeps z3-built.js as a classic
 * script. Copy the package-owned JS/WASM pair at build time so the files are
 * auditable build inputs without checking a generated binary into this repo.
 */
function z3ProbeAssets(): Plugin {
  return {
    name: "z3-probe-assets",
    apply: "build",
    generateBundle() {
      for (const [fileName, outputName] of [
        ["z3-built.js", "z3-built.js"],
        ["z3-built.wasm", "z3-built.wasm"],
        ["LICENSE.txt", "Z3-LICENSE.txt"],
      ] as const) {
        const sourceFile = fileName === "LICENSE.txt"
          ? require.resolve("z3-solver/LICENSE.txt")
          : require.resolve(`z3-solver/build/${fileName}`);
        this.emitFile({
          type: "asset",
          fileName: `assets/${outputName}`,
          source: readFileSync(sourceFile),
        });
      }

      for (const [sourceFile, outputName] of [
        [resolve(process.cwd(), "coi-bootstrap.js"), "coi-bootstrap.js"],
        [require.resolve("coi-serviceworker/coi-serviceworker.min.js"), "coi-serviceworker.js"],
        [require.resolve("coi-serviceworker/LICENSE"), "COI-SERVICEWORKER-LICENSE.txt"],
      ] as const) {
        this.emitFile({
          type: "asset",
          fileName: outputName,
          source: readFileSync(sourceFile),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), z3ProbeAssets()],
  // The application-level probe worker is emitted as a classic worker. This
  // lets it import the official Emscripten classic script with importScripts.
  worker: {
    format: "iife",
    rollupOptions: {
      output: {
        entryFileNames: "z3-probe/assets/[name]-[hash].js",
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(process.cwd(), "index.html"),
        z3Probe: resolve(process.cwd(), "z3-probe/index.html"),
      },
    },
  },
  // 相对路径可同时支持用户主页与项目主页两种 GitHub Pages 地址。
  base: "./",
});

/**
 * @fileoverview Vite build orchestration configuration for the DeepSurf browser extension.
 *
 * This configuration manages Chrome MV3 target compiles. It integrates the CRXJS plugin 
 * for Rollup-compatible bundle builds, handles custom WASM file copying assets, and 
 * overrides dependency optimizations to support on-device models.
 */

import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { crx } from "@crxjs/vite-plugin";
import { readFileSync, cpSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";

const manifest = JSON.parse(readFileSync("./manifest.base.json", "utf-8"));

/**
 * Bundles ONNX runtime WebAssembly binaries directly into the output assets folder.
 *
 * This step bypasses external CDN requests at extension run time.
 *
 * @returns {import("vite").Plugin} The custom Vite file copy plugin object.
 */
function copyOnnxWasm() {
  return {
    name: "copy-onnx-wasm",
    closeBundle() {
      const outDir = resolve("dist", "assets");
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

      const wasmSource = resolve("node_modules", "@xenova", "transformers", "dist");
      if (existsSync(wasmSource)) {
        const wasmFiles = ["ort-wasm.wasm", "ort-wasm-simd.wasm", "ort-wasm-simd-threaded.wasm"];
        for (const file of wasmFiles) {
          const src = resolve(wasmSource, file);
          if (existsSync(src)) {
            cpSync(src, resolve(outDir, file));
            console.log(`[DeepSurf:Build] Copied ${file} to assets/`);
          }
        }
      } else {
        console.warn("[DeepSurf:Build] ONNX WASM source directory not found. Run npm install first.");
      }
    },
  };
}

export default defineConfig(({ command }) => {
  // Dynamically determine production mode based on the Vite command being executed.
  // 'build' means we are packing for release; 'serve' means we are in dev mode.
  const isProduction = command === 'build';

  return {
    plugins: [
      svelte(),
      crx({ manifest }),
      copyOnnxWasm(),
    ],
    server: {
      port: 5173,
      strictPort: true,
      hmr: {
        port: 5173,
      },
    },
    resolve: {
      // Resolve alias override: we enforce using the ES6 bundled version of ONNX runtime
      // web to prevent duplicate imports and bundle size bloat.
      alias: {
        "onnxruntime-web": "onnxruntime-web/dist/ort.es6.min.js"
      }
    },
    optimizeDeps: {
      // Vite pre-bundling exclusions: we exclude large models and database libraries
      // from Vite pre-optimization because their dynamic imports and binary dependencies
      // cause dev server loader loops.
      exclude: [
        "@electric-sql/pglite", 
        "@xenova/transformers", 
        "@mlc-ai/web-llm"
      ],
    },
    
    // Conditionally strip console.log and console.info based on the dynamic isProduction flag.
    // Note: console.warn and console.error are safely preserved for production telemetry.
    esbuild: isProduction ? {
      pure: ['console.log', 'console.info'],
    } : {},

    build: {
      // Build target override: we use 'esnext' to support top-level await features
      // and WebGPU features native to modern browser architectures.
      target: "esnext",
      outDir: "dist", 
      emptyOutDir: true,
      rollupOptions: {
        // Rollup entry points: we define the offscreen document explicitly here
        // because CRXJS does not always automatically register files outside the manifest scope.
        input: {
          offscreen: "offscreen/index.html"
        }
      }
    }
  };
});
import { defineConfig } from "astro/config";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const API_URL = process.env.PUBLIC_API_URL || "http://localhost:3456";

// Resolve workspace packages from their TypeScript source so Vite doesn't
// need a build step for them. Using import.meta.url so paths are always
// relative to this config file, not the CWD (important for Docker).
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../..");
const workspaceAlias = {
  "@openfs/core":           resolve(root, "packages/core/src/index.ts"),
  "@openfs/grep-optimizer": resolve(root, "packages/grep-optimizer/src/index.ts"),
  "openfs-wasm":            resolve(root, "packages/wasm/src/index.ts"),
  "@openfs/agent-wiki":     resolve(root, "packages/agent-wiki/src/index.ts"),
  // Shim node:zlib for browser — just-bash imports gunzipSync but never uses it in-browser
  "node:zlib":              resolve(__dirname, "src/shims/node-zlib.js"),
  "zlib":                   resolve(__dirname, "src/shims/node-zlib.js"),
};

export default defineConfig({
  server: { port: 4321, host: true },
  vite: {
    resolve: {
      alias: workspaceAlias,
    },
    server: {
      proxy: {
        "/api": API_URL,
        "/health": API_URL,
        "/sync": {
          target: process.env.SYNC_URL || "http://localhost:4322",
          rewrite: (path) => path.replace(/^\/sync/, ""),
        },
      },
      allowedHosts: ["openfs.derekethandavis.com", ".derekethandavis.com"],
    },
    optimizeDeps: {
      exclude: ["sql.js"],
    },
  },
});

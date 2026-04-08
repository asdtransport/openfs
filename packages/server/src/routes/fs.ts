/**
 * Filesystem REST routes
 *
 * Maps HTTP endpoints to IFileSystem operations.
 * Supports adapter selection via `adapter` param ("sqlite" | "chroma").
 * Integrates grep optimizer for coarse→prefetch→fine pipeline.
 */

import { Hono } from "hono";
import type { OpenFsAdapter } from "@openfs/core";
import { parseGrepFlags, optimizeGrep, rewriteGrepCommand } from "@openfs/grep-optimizer";
import type { AdapterName, AdapterSet } from "../index.js";

type GetAdapter = (name: AdapterName) => AdapterSet | { error: string };

/**
 * Detect if a command is a standalone grep (not piped stdin).
 * Returns parsed args if it is, null otherwise.
 */
function detectGrep(command: string): string[] | null {
  const trimmed = command.trim();
  // Only intercept standalone grep commands, not `cat file | grep`
  if (trimmed.startsWith("grep ") || trimmed.startsWith("grep\t")) {
    // Don't intercept if it's part of a pipe (grep receiving stdin)
    // We only optimize `grep pattern /path` style invocations
    return trimmed.slice(5).trim().split(/\s+/);
  }
  return null;
}

export function createFsRoutes(sqliteAdapter: OpenFsAdapter, getAdapter: GetAdapter) {
  const routes = new Hono();

  // POST /api/fs/exec — run a shell command via just-bash
  // Body: { command: "ls /docs", adapter?: "sqlite"|"chroma" }
  // Grep commands are optimized via the coarse→prefetch→fine pipeline.
  routes.post("/exec", async (c) => {
    const body = await c.req.json();
    const command = body.command;
    if (!command || typeof command !== "string") {
      return c.json({ error: "command string required" }, 400);
    }

    const adapterName: AdapterName = body.adapter === "chroma" ? "chroma" : body.adapter === "s3" ? "s3" : "sqlite";
    const selected = getAdapter(adapterName);
    if ("error" in selected) {
      return c.json({ stdout: "", stderr: selected.error, exitCode: 1 });
    }

    try {
      // --- Grep optimizer interception ---
      const grepArgs = detectGrep(command);
      let finalCommand = command;
      let optimized = false;
      let candidateCount: number | undefined;

      if (grepArgs && grepArgs.length > 0) {
        const flags = parseGrepFlags(grepArgs);
        // Only optimize if we have a pattern and target paths (not stdin grep)
        if (flags.pattern && flags.paths.length > 0) {
          const adapter = selected.adapter;
          const { candidates } = await optimizeGrep(adapter, flags);

          if (candidates.length > 0) {
            const candidatePaths = candidates.map((c) => c.path);
            const rewritten = rewriteGrepCommand(grepArgs, candidatePaths);
            finalCommand = "grep " + rewritten.join(" ");
            optimized = true;
            candidateCount = candidates.length;
          } else {
            // No candidates from coarse search — skip execution entirely
            return c.json({
              stdout: "",
              stderr: "",
              exitCode: 1,
              adapter: selected.name,
              optimized: true,
              candidates: 0,
            });
          }
        }
      }

      const result = await selected.bash.exec(finalCommand);
      return c.json({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        adapter: selected.name,
        ...(optimized ? { optimized: true, candidates: candidateCount } : {}),
      });
    } catch (err: any) {
      return c.json({
        stdout: "",
        stderr: err.message || String(err),
        exitCode: 1,
        adapter: selected.name,
      });
    }
  });

  // GET /api/fs/read?path=...&adapter=sqlite|chroma
  routes.get("/read", async (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path query parameter required" }, 400);
    try {
      const content = await sqliteAdapter.readFile(path);
      return c.json({ path, content });
    } catch (err: any) {
      return c.json({ error: err.message }, 404);
    }
  });

  // GET /api/fs/readdir?path=...&adapter=sqlite|chroma
  routes.get("/readdir", async (c) => {
    const path = c.req.query("path") || "/";
    const adapterName: AdapterName = c.req.query("adapter") === "chroma" ? "chroma" : c.req.query("adapter") === "s3" ? "s3" : "sqlite";
    const selected = getAdapter(adapterName);
    if ("error" in selected) return c.json({ error: selected.error }, 503);
    try {
      const entries = selected.tree.readdir(path);
      return c.json({ path, entries, adapter: selected.name });
    } catch (err: any) {
      return c.json({ error: err.message }, 404);
    }
  });

  // GET /api/fs/exists?path=...&adapter=sqlite|chroma
  routes.get("/exists", async (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path query parameter required" }, 400);
    const adapterName: AdapterName = c.req.query("adapter") === "chroma" ? "chroma" : c.req.query("adapter") === "s3" ? "s3" : "sqlite";
    const selected = getAdapter(adapterName);
    if ("error" in selected) return c.json({ error: selected.error }, 503);
    return c.json({ path, exists: selected.tree.exists(path), adapter: selected.name });
  });

  // POST /api/fs/search { query: "...", adapter?: "sqlite"|"chroma" }
  routes.post("/search", async (c) => {
    const body = await c.req.json();
    const query = body.query;
    if (!query) return c.json({ error: "query string required" }, 400);
    const results = await sqliteAdapter.search(query, body.flags);
    return c.json({ query, results });
  });

  return routes;
}

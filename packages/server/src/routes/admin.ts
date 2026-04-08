/**
 * Admin routes for managing collections and ingestion.
 */

import { Hono } from "hono";
import type { SqliteAdapter } from "@openfs/adapter-sqlite";

export function createAdminRoutes(adapter: SqliteAdapter) {
  const routes = new Hono();

  // GET /api/admin/stats
  routes.get("/stats", async (c) => {
    const stats = adapter.getStats();
    return c.json(stats);
  });

  // POST /api/admin/ingest { files: { "/path": "content" } }
  routes.post("/ingest", async (c) => {
    const body = await c.req.json();
    const files = body.files as Record<string, string> | undefined;
    if (!files || typeof files !== "object") {
      return c.json({ error: "files object required" }, 400);
    }
    adapter.ingestDirectory(files);
    return c.json({ ingested: Object.keys(files).length });
  });

  return routes;
}

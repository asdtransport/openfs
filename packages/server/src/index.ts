/**
 * @openfs/server
 *
 * Hono API server for remote OpenFS filesystem access.
 * Initializes SQLite, Chroma, and S3 (MinIO) adapters with shared sample docs.
 * The /api/fs/exec endpoint accepts an `adapter` field ("sqlite" | "chroma" | "s3")
 * so the playground can let users switch between backing stores.
 *
 * Run: bun run --hot src/index.ts
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "hono/bun";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { Bash } from "just-bash";
import { PathTree } from "@openfs/core";
import { createOpenFs } from "@openfs/core";
import { SqliteAdapter } from "@openfs/adapter-sqlite";
import { ChromaAdapter } from "@openfs/adapter-chroma";
import { S3Adapter } from "@openfs/adapter-s3";
import { createFsRoutes } from "./routes/fs.js";
import { createAdminRoutes } from "./routes/admin.js";
import { healthRoutes } from "./routes/health.js";
import { s3ApiRoutes } from "./routes/s3-api.js";

// --- Sample documentation (shared across both adapters) ---
const SAMPLE_DOCS: Record<string, string> = {
  "/docs/getting-started.mdx": `# Getting Started

Welcome to our API. To authenticate, you'll need an access_token.

## Installation

\`\`\`bash
npm install our-sdk
\`\`\`

## Quick Start

Use your access_token in the Authorization header:

\`\`\`
Authorization: Bearer <your_access_token>
\`\`\`
`,
  "/docs/auth/oauth.mdx": `# OAuth 2.0

Our API uses OAuth 2.0 for authentication.

## Getting an access_token

1. Register your application
2. Redirect users to the authorization URL
3. Exchange the code for an access_token
4. Use the access_token in API requests

## Refresh Tokens

When your access_token expires, use the refresh_token to get a new one.
`,
  "/docs/auth/api-keys.mdx": `# API Keys

API keys are an alternative to OAuth for server-to-server communication.

## Creating an API Key

Navigate to Settings → API Keys and click "Create New Key".

## Usage

Include the key in the X-API-Key header:

\`\`\`
X-API-Key: your_api_key_here
\`\`\`
`,
  "/docs/api/users.mdx": `# Users API

## GET /users

Returns a list of users. Requires access_token in the Authorization header.

### Parameters

- limit: Maximum number of results (default: 20)
- offset: Pagination offset

### Response

\`\`\`json
{
  "users": [{"id": 1, "name": "Alice"}],
  "total": 100
}
\`\`\`
`,
  "/docs/api/webhooks.mdx": `# Webhooks

Configure webhooks to receive real-time notifications.

## Setup

1. Navigate to Settings → Webhooks
2. Add your endpoint URL
3. Select events to subscribe to

## Webhook Payload

Each webhook includes a signature in the X-Webhook-Signature header.
Verify the signature using your webhook_secret.

## Events

- user.created
- user.updated
- invoice.paid
- subscription.cancelled
`,
  "/docs/guides/quickstart.mdx": `# Quick Start Guide

Get started by generating an access_token using the OAuth guide.

## Step 1: Create an Application

Go to the developer portal and register a new application.

## Step 2: Authenticate

Follow the OAuth 2.0 flow to get your access_token.

## Step 3: Make Your First Request

\`\`\`bash
curl -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \\
  https://api.example.com/users
\`\`\`
`,
};

// ============================================================
// 1. SQLite adapter
// ============================================================
const DB_PATH = process.env.OPENFS_DB || ":memory:";
const sqliteAdapter = new SqliteAdapter({ dbPath: DB_PATH });
sqliteAdapter.ingestDirectory(SAMPLE_DOCS);

const sqlitePathMap = await sqliteAdapter.init();
const sqliteTree = new PathTree();
sqliteTree.build(sqlitePathMap);

const sqliteFs = createOpenFs(sqliteAdapter, { pathTree: sqliteTree });
const sqliteBash = new Bash({ fs: sqliteFs, cwd: "/" });

console.log(`📂 SQLite: ${sqliteTree.fileCount} files loaded (${DB_PATH})`);

// ============================================================
// 2. Chroma adapter (needs CHROMA_URL — set via docker-compose)
// ============================================================
const CHROMA_URL = process.env.CHROMA_URL || "http://localhost:8000";
const COLLECTION = "openfs-playground";

let chromaBash: Bash | null = null;
let chromaTree: PathTree | null = null;
let chromaAdapter: ChromaAdapter | null = null;
let chromaError: string | null = null;

try {
  chromaAdapter = new ChromaAdapter({
    collectionName: COLLECTION,
    chromaUrl: CHROMA_URL,
  });
  await chromaAdapter.ingestDocuments(SAMPLE_DOCS);

  const chromaPathMap = await chromaAdapter.init();
  chromaTree = new PathTree();
  chromaTree.build(chromaPathMap);

  const chromaFs = createOpenFs(chromaAdapter, { pathTree: chromaTree });
  chromaBash = new Bash({ fs: chromaFs, cwd: "/" });

  console.log(`🔮 Chroma: ${chromaTree.fileCount} files loaded (${CHROMA_URL}, collection: ${COLLECTION})`);
} catch (err: any) {
  chromaError = err.message || String(err);
  console.warn(`⚠️  Chroma unavailable: ${chromaError}`);
}

// ============================================================
// 3. S3 / MinIO adapter
// ============================================================
const S3_ENDPOINT = process.env.S3_ENDPOINT || "http://localhost:9000";
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || "minioadmin";
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || "minioadmin";
const S3_BUCKET = process.env.S3_BUCKET || "openfs-playground";

let s3Bash: Bash | null = null;
let s3Tree: PathTree | null = null;
let s3Adapter: S3Adapter | null = null;
let s3Error: string | null = null;

try {
  s3Adapter = new S3Adapter({
    bucket: S3_BUCKET,
    endpoint: S3_ENDPOINT,
    accessKeyId: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_KEY,
    forcePathStyle: true,
  });
  await s3Adapter.ingestDocuments(SAMPLE_DOCS);

  const s3PathMap = await s3Adapter.init();
  s3Tree = new PathTree();
  s3Tree.build(s3PathMap);

  const s3Fs = createOpenFs(s3Adapter, { pathTree: s3Tree });
  s3Bash = new Bash({ fs: s3Fs, cwd: "/" });

  console.log(`🪣 S3/MinIO: ${s3Tree.fileCount} files loaded (${S3_ENDPOINT}, bucket: ${S3_BUCKET})`);
} catch (err: any) {
  s3Error = err.message || String(err);
  console.warn(`⚠️  S3/MinIO unavailable: ${s3Error}`);
}

// ============================================================
// Bash instances map — routes pick the right one
// ============================================================
export type AdapterName = "sqlite" | "chroma" | "s3";

export interface AdapterSet {
  bash: Bash;
  tree: PathTree;
  adapter: import("@openfs/core").OpenFsAdapter;
  name: string;
}

function getAdapter(name: AdapterName): AdapterSet | { error: string } {
  if (name === "chroma") {
    if (!chromaBash || !chromaTree) {
      return { error: chromaError || "Chroma adapter not available" };
    }
    return { bash: chromaBash, tree: chromaTree, adapter: chromaAdapter!, name: "chroma" };
  }
  if (name === "s3") {
    if (!s3Bash || !s3Tree) {
      return { error: s3Error || "S3 adapter not available" };
    }
    return { bash: s3Bash, tree: s3Tree, adapter: s3Adapter!, name: "s3" };
  }
  return { bash: sqliteBash, tree: sqliteTree, adapter: sqliteAdapter, name: "sqlite" };
}

// --- App ---
const app = new Hono();

// Middleware
app.use("*", logger());
app.use("*", cors());

// Routes
app.route("/health", healthRoutes);
app.route("/api/fs", createFsRoutes(sqliteAdapter, getAdapter));
app.route("/api/admin", createAdminRoutes(sqliteAdapter));
app.route("/api/s3", s3ApiRoutes);

// ── MinIO Console reverse proxy ──────────────────────────────────────────────
const MINIO_CONSOLE = process.env.MINIO_CONSOLE_URL || "http://localhost:9001";

app.all("/minio", (c) => c.redirect("/minio/", 301));

app.all("/minio/*", async (c) => {
  const url = new URL(c.req.url);
  const path = url.pathname.replace(/^\/minio/, "") || "/";
  const targetUrl = `${MINIO_CONSOLE}${path}${url.search}`;
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(c.req.header())) {
      const k = key.toLowerCase();
      if (k !== "host" && k !== "content-length" && k !== "transfer-encoding" && value) {
        headers.set(key, value);
      }
    }
    const fetchOpts: RequestInit = { method: c.req.method, headers, redirect: "follow" };
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      fetchOpts.body = await c.req.raw.arrayBuffer();
    }
    const upstream = await fetch(targetUrl, fetchOpts);
    const responseHeaders = new Headers();
    upstream.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (k !== "transfer-encoding" && k !== "content-encoding" && k !== "content-length") {
        responseHeaders.set(key, value);
      }
    });

    const contentType = upstream.headers.get("content-type") || "";

    // Rewrite HTML: fix absolute asset paths (/static/…, /ws, etc.) to /minio/…
    if (contentType.includes("text/html")) {
      let html = await upstream.text();
      // Rewrite src="/  href="/  action="/  url(/  to include /minio prefix
      html = html
        .replace(/(src|href|action)="\//g, '$1="/minio/')
        .replace(/url\(\//g, "url(/minio/")
        .replace(/(content|href)="\/minio\/minio\//g, '$1="/minio/'); // avoid double prefix
      responseHeaders.set("content-type", "text/html; charset=utf-8");
      return new Response(html, { status: upstream.status, headers: responseHeaders });
    }

    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch (err: any) {
    return c.json({ error: "MinIO Console unavailable", detail: err.message }, 503);
  }
});

// ── MinIO Console internal API proxy (/api/v1/* → MinIO console :9001) ──────
// The MinIO SPA makes XHR calls to /api/v1/* using absolute paths. Since the
// SPA is served through /minio/, these calls land here rather than at /minio/api/v1/*.
app.all("/api/v1/*", async (c) => {
  const url = new URL(c.req.url);
  const targetUrl = `${MINIO_CONSOLE}${url.pathname}${url.search}`;
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(c.req.header())) {
      const k = key.toLowerCase();
      if (k !== "host" && k !== "content-length" && k !== "transfer-encoding" && value) {
        headers.set(key, value);
      }
    }
    const fetchOpts: RequestInit = { method: c.req.method, headers };
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      fetchOpts.body = await c.req.raw.arrayBuffer();
    }
    const upstream = await fetch(targetUrl, fetchOpts);
    const responseHeaders = new Headers();
    upstream.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (k !== "transfer-encoding" && k !== "content-encoding" && k !== "content-length") {
        responseHeaders.set(key, value);
      }
    });
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch (err: any) {
    return c.json({ error: "MinIO Console API unavailable", detail: err.message }, 503);
  }
});

// ── MediaWiki reverse proxy ───────────────────────────────────────────────────
const MW_INTERNAL = process.env.MW_URL || "http://localhost:8082";

app.all("/mw/*", async (c) => {
  const url = new URL(c.req.url);
  const path = url.pathname.replace(/^\/mw/, "");
  const targetUrl = `${MW_INTERNAL}${path}${url.search}`;
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(c.req.header())) {
      // Drop hop-by-hop headers; content-length is recalculated below
      if (["host", "content-length", "transfer-encoding"].includes(key.toLowerCase())) continue;
      if (value) headers.set(key, value);
    }
    const fetchOpts: RequestInit = { method: c.req.method, headers };
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const body = await c.req.raw.text();
      fetchOpts.body = body;
      // PHP built-in server needs Content-Length to read the full POST body.
      // Without it, wpLoginToken is missing and MW throws "session hijacking".
      headers.set("content-length", new TextEncoder().encode(body).length.toString());
    }
    const upstream = await fetch(targetUrl, fetchOpts);
    const responseHeaders = new Headers();
    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "transfer-encoding") responseHeaders.set(key, value);
    });
    // Set-Cookie must use append — set() collapses multiple cookies to one,
    // dropping session/username/token cookies and breaking MW login persistence.
    const cookies = upstream.headers.getSetCookie?.() ?? [];
    if (cookies.length > 0) {
      responseHeaders.delete("set-cookie");
      for (const c of cookies) responseHeaders.append("set-cookie", c);
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch (err: any) {
    return c.json({ error: "MediaWiki unavailable", detail: err.message }, 503);
  }
});

// ── Sync server proxy (agent-wiki-mw) ─────────────────────────────────────────
const SYNC_URL = process.env.SYNC_URL || "http://localhost:4322";

app.all("/sync/*", async (c) => {
  const url = new URL(c.req.url);
  const path = url.pathname.replace(/^\/sync/, "");
  const targetUrl = `${SYNC_URL}${path}${url.search}`;
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(c.req.header())) {
      if (key.toLowerCase() !== "host" && key.toLowerCase() !== "content-length" && value) {
        headers.set(key, value);
      }
    }
    const fetchOpts: RequestInit = { method: c.req.method, headers };
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      fetchOpts.body = await c.req.raw.text();
    }
    const upstream = await fetch(targetUrl, fetchOpts);
    const responseHeaders = new Headers();
    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "transfer-encoding") responseHeaders.set(key, value);
    });
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch (err: any) {
    return c.json({ error: "Sync server unavailable", detail: err.message }, 503);
  }
});

// ── Static playground serving (production) ────────────────────────────────────
const STATIC_DIR = process.env.STATIC_DIR;

if (STATIC_DIR && existsSync(STATIC_DIR)) {
  console.log(`📁 Serving static playground from ${STATIC_DIR}`);

  // Serve static assets
  app.use("/*", serveStatic({ root: STATIC_DIR }));

  // SPA fallback — serve index.html for unmatched routes
  app.get("*", (c) => {
    const indexPath = join(STATIC_DIR, "index.html");
    if (existsSync(indexPath)) {
      const html = readFileSync(indexPath, "utf-8");
      return c.html(html);
    }
    return c.json({ error: "index.html not found" }, 404);
  });
} else {
  // Dev/API-only mode — show JSON landing
  app.get("/", (c) =>
    c.json({
      name: "@openfs/server",
      version: "0.1.0",
      adapters: {
        sqlite: "ready",
        chroma: chromaBash ? "ready" : `unavailable: ${chromaError}`,
        s3: s3Bash ? "ready" : `unavailable: ${s3Error}`,
      },
      s3_api: {
        status: "proxied",
        upstream: process.env.MINIO_API_URL || "http://localhost:8080",
        docs: `${process.env.MINIO_API_URL || "http://localhost:8080"}/docs`,
        proxy: "/api/s3/* -> adapter-s3-api /api/v1/*",
      },
      endpoints: {
        exec: 'POST /api/fs/exec  { command: "ls /docs", adapter: "sqlite"|"chroma"|"s3" }',
        read: "GET  /api/fs/read?path=/docs/auth/oauth.mdx",
        readdir: "GET  /api/fs/readdir?path=/docs&adapter=sqlite|chroma|s3",
        search: 'POST /api/fs/search  { query: "access_token" }',
        s3_buckets: "GET  /api/s3/buckets",
        s3_objects: "GET  /api/s3/objects/list/{bucket}",
        s3_health: "GET  /api/s3/monitoring/health",
        health: "GET  /health",
      },
    }),
  );
}

const port = parseInt(process.env.PORT || "3456", 10);
console.log(`🗂️  OpenFS server running on http://localhost:${port}`);

// ── Bun WebSocket proxy for MinIO console (/minio/ws/*) ──────────────────────
// Hono's HTTP proxy can't upgrade connections — handle upgrades here before
// passing to app.fetch so the MinIO object browser works.
const MINIO_CONSOLE_WS = (process.env.MINIO_CONSOLE_URL || "http://localhost:9001")
  .replace(/^http/, "ws");

export default {
  port,
  async fetch(req: Request, server: any) {
    const url = new URL(req.url);

    // WebSocket upgrade for MinIO console
    // Forward cookie + auth so MinIO's /ws/objectManager accepts the connection.
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket" && url.pathname.startsWith("/minio/")) {
      const wsPath = url.pathname.replace(/^\/minio/, "") || "/";
      const upstreamUrl = `${MINIO_CONSOLE_WS}${wsPath}${url.search}`;
      const cookie   = req.headers.get("cookie") || "";
      const auth     = req.headers.get("authorization") || "";
      const protocol = req.headers.get("sec-websocket-protocol") || "";
      const upgraded = server.upgrade(req, { data: { upstreamUrl, upstream: null as WebSocket | null, cookie, auth, protocol } });
      if (upgraded) return;
    }

    return app.fetch(req);
  },
  websocket: {
    open(ws: any) {
      const { upstreamUrl, cookie, auth, protocol } = ws.data;
      try {
        const upstreamHeaders: Record<string, string> = {};
        if (cookie)   upstreamHeaders["Cookie"] = cookie;
        if (auth)     upstreamHeaders["Authorization"] = auth;
        if (protocol) upstreamHeaders["Sec-WebSocket-Protocol"] = protocol;
        const upstream = new WebSocket(upstreamUrl, { headers: upstreamHeaders } as any);
        ws.data.upstream = upstream;
        upstream.onopen = () => {};
        upstream.onmessage = (e: MessageEvent) => {
          try { ws.send(e.data); } catch {}
        };
        upstream.onclose = () => { try { ws.close(); } catch {} };
        upstream.onerror = () => { try { ws.close(); } catch {} };
      } catch (e) {
        ws.close();
      }
    },
    message(ws: any, message: string | Buffer) {
      const upstream = ws.data.upstream as WebSocket | null;
      if (upstream?.readyState === WebSocket.OPEN) {
        try { upstream.send(message); } catch {}
      }
    },
    close(ws: any) {
      try { ws.data.upstream?.close(); } catch {}
    },
  },
};

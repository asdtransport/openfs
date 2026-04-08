/**
 * Chroma Adapter Integration Test
 *
 * Requires Chroma server running at CHROMA_URL (default: http://chroma:8000)
 * Run via: docker compose up && docker compose exec openfs bun test tests/chroma.test.ts
 *
 * Or locally: chroma run --path ./chroma_data & CHROMA_URL=http://localhost:8000 bun test tests/chroma.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Bash } from "just-bash";
import { ChromaClient } from "chromadb";
import { PathTree } from "../packages/core/src/path-tree";
import { createOpenFs } from "../packages/core/src/openfs";
import { ChromaAdapter } from "../packages/adapter-chroma/src/chroma-adapter";

const COLLECTION_NAME = "openfs-test-docs";
const CHROMA_URL = process.env.CHROMA_URL || "http://chroma:8000";

const SAMPLE_DOCS: Record<string, string> = {
  "/docs/getting-started.mdx":
    "# Getting Started\n\nWelcome to the API. Use your access_token to authenticate.\n\n```\nAuthorization: Bearer <access_token>\n```\n",
  "/docs/auth/oauth.mdx":
    "# OAuth 2.0\n\nExchange an authorization code for an access_token.\nUse refresh_token when the access_token expires.\n",
  "/docs/auth/api-keys.mdx":
    "# API Keys\n\nUse X-API-Key header for server-to-server auth.\nNavigate to Settings to create a key.\n",
  "/docs/api/users.mdx":
    "# Users API\n\nGET /users — returns a list of users.\nRequires access_token in the Authorization header.\n",
  "/docs/api/webhooks.mdx":
    "# Webhooks\n\nConfigure webhook endpoints to receive events.\nVerify signature with webhook_secret.\n\nEvents: user.created, invoice.paid\n",
};

describe("Chroma Adapter", () => {
  let adapter: ChromaAdapter;
  let rawClient: ChromaClient;

  beforeAll(async () => {
    rawClient = new ChromaClient({ host: CHROMA_URL });
    try { await rawClient.deleteCollection({ name: COLLECTION_NAME }); } catch {}

    adapter = new ChromaAdapter({ collectionName: COLLECTION_NAME, chromaUrl: CHROMA_URL });
    await adapter.init();
    await adapter.ingestDocuments(SAMPLE_DOCS);
    await adapter.init(); // re-init to load __path_tree__
  });

  afterAll(async () => {
    try { await rawClient.deleteCollection({ name: COLLECTION_NAME }); } catch {}
    await adapter.close();
  });

  test("init returns path tree with all files", async () => {
    const pathMap = await adapter.init();
    expect(pathMap.size).toBe(5);
    expect(pathMap.has("/docs/getting-started.mdx")).toBe(true);
    expect(pathMap.has("/docs/auth/oauth.mdx")).toBe(true);
  });

  test("readFile returns content", async () => {
    const content = await adapter.readFile("/docs/auth/oauth.mdx");
    expect(content).toContain("OAuth 2.0");
    expect(content).toContain("access_token");
  });

  test("search finds files with $contains", async () => {
    const results = await adapter.search("access_token");
    expect(results.length).toBeGreaterThanOrEqual(2);
    const paths = results.map(r => r.path);
    expect(paths).toContain("/docs/getting-started.mdx");
  });

  test("search finds webhook files", async () => {
    const results = await adapter.search("webhook");
    const paths = results.map(r => r.path);
    expect(paths).toContain("/docs/api/webhooks.mdx");
  });

  test("bulkPrefetch loads multiple files", async () => {
    const prefetched = await adapter.bulkPrefetch(["/docs/auth/oauth.mdx", "/docs/auth/api-keys.mdx"]);
    expect(prefetched.size).toBe(2);
    expect(prefetched.get("/docs/auth/oauth.mdx")).toContain("OAuth");
  });
});

describe("Chroma + just-bash Integration", () => {
  let bash: Bash;
  let adapter: ChromaAdapter;

  beforeAll(async () => {
    adapter = new ChromaAdapter({ collectionName: COLLECTION_NAME, chromaUrl: CHROMA_URL });
    const pathMap = await adapter.init();
    const tree = new PathTree();
    tree.build(pathMap);
    bash = new Bash({ fs: createOpenFs(adapter, { pathTree: tree }), cwd: "/" });
  });

  afterAll(async () => { await adapter.close(); });

  test("ls / shows docs", async () => {
    const r = await bash.exec("ls /");
    expect(r.stdout.trim()).toBe("docs");
  });

  test("ls /docs shows entries", async () => {
    const r = await bash.exec("ls /docs");
    expect(r.stdout).toContain("auth");
    expect(r.stdout).toContain("api");
    expect(r.stdout).toContain("getting-started.mdx");
  });

  test("cat reads from Chroma", async () => {
    const r = await bash.exec("cat /docs/auth/oauth.mdx");
    expect(r.stdout).toContain("OAuth 2.0");
    expect(r.exitCode).toBe(0);
  });

  test("cat | grep pipes work", async () => {
    const r = await bash.exec("cat /docs/auth/oauth.mdx | grep access_token");
    expect(r.stdout).toContain("access_token");
    expect(r.exitCode).toBe(0);
  });

  test("head reads first lines", async () => {
    const r = await bash.exec("head -2 /docs/getting-started.mdx");
    expect(r.stdout).toContain("Getting Started");
  });
});

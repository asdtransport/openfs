/**
 * OpenFS p50/p90/p99 benchmark
 *
 * Measures the grep optimizer pipeline (coarse → prefetch → fine)
 * and individual filesystem operations at percentile latencies.
 *
 * Run: bun run tests/bench.ts
 */

import { Bash } from "just-bash";
import { createOpenFs } from "@openfs/core";
import { PathTree } from "@openfs/core";
import { SqliteAdapter } from "@openfs/adapter-sqlite";

// ── Corpus ────────────────────────────────────────────────────────────────────
// 100 synthetic docs — enough to show grep optimizer benefit
const DOCS: Record<string, string> = {};

const TOPICS = ["auth", "billing", "webhooks", "users", "api-reference", "guides", "internal"];
const TOKENS = ["access_token", "refresh_token", "webhook_secret", "api_key", "Bearer", "OAuth"];

for (let i = 0; i < 100; i++) {
  const topic = TOPICS[i % TOPICS.length];
  const hasToken = i % 3 === 0; // ~33% of docs contain a search token
  const token = TOKENS[i % TOKENS.length];
  DOCS[`/docs/${topic}/doc-${i}.mdx`] = [
    `# ${topic} document ${i}`,
    "",
    hasToken
      ? `Use ${token} in the Authorization header for all requests.`
      : "This document does not contain any authentication tokens.",
    "",
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
    "Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
    hasToken ? `Remember to rotate your ${token} every 90 days.` : "",
  ].join("\n");
}

// ── Percentile helper ─────────────────────────────────────────────────────────
function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function fmt(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(2)}ms`;
}

async function bench(label: string, n: number, fn: () => Promise<void>) {
  // warmup
  for (let i = 0; i < 3; i++) await fn();

  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);

  console.log(
    `  ${label.padEnd(40)}` +
    `p50 ${fmt(percentile(times, 50)).padStart(8)}  ` +
    `p90 ${fmt(percentile(times, 90)).padStart(8)}  ` +
    `p99 ${fmt(percentile(times, 99)).padStart(8)}`
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
const adapter = new SqliteAdapter({ dbPath: ":memory:" });
adapter.ingestDirectory(DOCS);
const pathMap = await adapter.init();

const tree = new PathTree();
tree.build(pathMap);

const fs = createOpenFs(adapter, { pathTree: tree });
const bash = new Bash({ fs, cwd: "/" });

console.log(`\nOpenFS benchmark  —  ${Object.keys(DOCS).length} docs, :memory: SQLite\n`);
console.log(
  `  ${"operation".padEnd(40)}` +
  `${"p50".padStart(12)}  ` +
  `${"p90".padStart(12)}  ` +
  `${"p99".padStart(12)}`
);
console.log("  " + "─".repeat(78));

// ls — in-memory PathTree, no DB
await bench("ls /docs", 200, async () => {
  await bash.exec("ls /docs");
});

await bench("ls /docs/auth", 200, async () => {
  await bash.exec("ls /docs/auth");
});

// cat — single file read
await bench("cat /docs/auth/doc-0.mdx", 200, async () => {
  await bash.exec("cat /docs/auth/doc-0.mdx");
});

// head — first 3 lines
await bench("head -3 /docs/auth/doc-0.mdx", 200, async () => {
  await bash.exec("head -3 /docs/auth/doc-0.mdx");
});

// grep with optimizer (hits ~33% of files)
await bench("grep -r access_token /docs (optimizer)", 100, async () => {
  await bash.exec("grep -r access_token /docs");
});

await bench("grep -ri bearer /docs (optimizer)", 100, async () => {
  await bash.exec("grep -ri bearer /docs");
});

// grep worst-case: no matches (optimizer short-circuits)
await bench("grep -r NOMATCH /docs (0 candidates)", 100, async () => {
  await bash.exec("grep -r NOMATCH_XYZ_ABC /docs");
});

// stat
await bench("stat /docs/auth/doc-0.mdx", 200, async () => {
  await bash.exec("stat /docs/auth/doc-0.mdx");
});

// search (FTS5 directly via adapter)
await bench("adapter.search('access_token')", 200, async () => {
  await adapter.search("access_token");
});

await bench("adapter.search('OAuth') case-insensitive", 200, async () => {
  await adapter.search("OAuth");
});

// bulk prefetch (simulates what optimizer does before fine grep)
const allPaths = Object.keys(DOCS).slice(0, 10);
await bench("bulkPrefetch (10 files)", 100, async () => {
  await adapter.bulkPrefetch(allPaths);
});

console.log();
console.log(`  Corpus: ${Object.keys(DOCS).length} docs across ${TOPICS.length} topics`);
console.log(`  ~33% of docs contain a search token (realistic hit rate)`);
console.log(`  grep optimizer: coarse FTS5 → bulkPrefetch → fine regex`);
console.log();

/**
 * One-shot: copy pages from local MW → Railway MW
 * Migrates: Main_Page + all Category:OpenFS Synthesized members + all namespace-0 pages
 * Run: bun run migrate-wiki.ts
 */
import { MwBot } from "./packages/agent-wiki-mw/src/bot.js";

const LOCAL_MW  = "http://localhost:8082";
const REMOTE_MW = "https://openfs-production.up.railway.app/mw";
const REMOTE_USER = "derek";
const REMOTE_PASS = "Yugioh4444!";
const LOCAL_USER  = process.env.MW_USER  ?? "Derek";
const LOCAL_PASS  = process.env.MW_PASS  ?? "Yugioh4444!";

console.log("Connecting to local MW...");
const local = new MwBot({ baseUrl: LOCAL_MW, username: LOCAL_USER, password: LOCAL_PASS });
await local.login();
console.log("✓ Local MW logged in");

console.log("Connecting to Railway MW...");
const remote = new MwBot({ baseUrl: REMOTE_MW, username: REMOTE_USER, password: REMOTE_PASS });
await remote.login();
console.log("✓ Railway MW logged in");

// Gather all titles we want to migrate (deduplicated)
const titleSet = new Set<string>();

// 1. Always include Main_Page
titleSet.add("Main_Page");

// 2. All pages in Category:OpenFS Synthesized
const synthesized = await local.getCategoryMembers("OpenFS Synthesized", 1000);
console.log(`Found ${synthesized.length} pages in Category:OpenFS Synthesized`);
for (const t of synthesized) titleSet.add(t);

// 3. All regular namespace-0 pages
const allPages = await local.getAllPages({ limit: 1000 });
console.log(`Found ${allPages.length} total namespace-0 pages`);
for (const t of allPages) titleSet.add(t);

const titles = Array.from(titleSet);
console.log(`\nMigrating ${titles.length} unique pages...\n`);

let pushed = 0, failed = 0, skipped = 0;
for (const title of titles) {
  try {
    const page = await local.getPage(title);
    if (!page?.content?.trim()) {
      console.log(`  skip (empty): ${title}`);
      skipped++;
      continue;
    }
    await remote.editPage(title, page.content, "Migrated from local wiki");
    console.log(`  ✓ ${title}`);
    pushed++;
    await new Promise(r => setTimeout(r, 300)); // rate limit breathing room
  } catch (e: any) {
    // Back off on rate limit errors
    if (e.message?.includes("ratelimited") || e.message?.includes("rate")) {
      console.warn(`  ⏳ rate limited on ${title}, waiting 5s...`);
      await new Promise(r => setTimeout(r, 5000));
      try {
        const page = await local.getPage(title);
        if (page?.content?.trim()) {
          await remote.editPage(title, page.content, "Migrated from local wiki");
          console.log(`  ✓ ${title} (retry)`);
          pushed++;
          continue;
        }
      } catch {}
    }
    console.error(`  ✗ ${title}: ${e.message}`);
    failed++;
  }
}

console.log(`\nDone: ${pushed} pushed, ${skipped} skipped (empty), ${failed} failed`);

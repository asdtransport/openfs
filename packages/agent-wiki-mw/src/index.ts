/**
 * @openfs/agent-wiki-mw
 *
 * Connects a live MediaWiki instance to the OpenFS LLM wiki pipeline.
 *
 * Usage:
 *   const bot  = new MwBot({ baseUrl: "http://localhost:8082", username: "Admin", password: "..." });
 *   await bot.login();
 *
 *   const fs   = await createAgentFs({ writable: true });
 *   const wiki = await AgentWiki.create(fs, myLlm);
 *   const sync = new OpenFsMwSync(bot, wiki);
 *
 *   // Pull all MW pages into OpenFS
 *   await sync.pullAll({ verbose: true });
 *
 *   // Ask a question — answer optionally written back to MW
 *   const answer = await sync.query("What is Derek's approach to health?", { persist: true });
 *
 *   // Ingest a new diary entry and sync results to MW
 *   await sync.ingestAndSync("2026-04-05.md", diaryText);
 */

export { MwBot } from "./bot.js";
export type { MwPage, MwBotOptions } from "./bot.js";
export { OpenFsMwSync } from "./sync.js";
export type { SyncOptions } from "./sync.js";

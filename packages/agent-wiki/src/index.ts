/**
 * @openfs/agent-wiki
 *
 * Persistent, compounding AI knowledge base on top of OpenFS.
 *
 * Usage:
 *   import { AgentWiki, createClaudeAdapter } from "@openfs/agent-wiki";
 *   import { createAgentFs } from "openfs-wasm";
 *
 *   const fs   = await createAgentFs({ writable: true });
 *   const llm  = createClaudeAdapter({ apiKey: "sk-ant-..." });
 *   const wiki = await AgentWiki.create(fs, llm);
 *
 *   await wiki.ingest("paper.md", rawText);
 *   const { answer } = await wiki.query("how does auth work?");
 *   const { issues } = await wiki.lint();
 */

export { AgentWiki } from "./wiki";

// Types
export type {
  LlmAdapter,
  WikiOptions,
  IngestResult,
  QueryResult,
  LintResult,
  LintIssue,
  WikiPage,
  SourceFile,
  LogEntry,
  LlmIngestResponse,
  LlmQueryResponse,
  LlmLintResponse,
} from "./types";

// LLM adapters
export {
  createClaudeAdapter,
  createOpenAiAdapter,
  createCustomAdapter,
} from "./adapters";
export type {
  ClaudeAdapterOptions,
  OpenAiAdapterOptions,
  CustomAdapterOptions,
} from "./adapters";

// Prompt builders (export for customisation)
export {
  WIKI_SYSTEM_PROMPT,
  DEFAULT_SCHEMA,
  buildIngestPrompt,
  buildQueryPrompt,
  buildLintPrompt,
  buildIndexPrompt,
} from "./prompts";
export type {
  IngestPromptOpts,
  QueryPromptOpts,
  LintPromptOpts,
  IndexPromptOpts,
} from "./prompts";

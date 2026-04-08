/**
 * @openfs/agent-wiki — Built-in LLM adapters
 *
 * Bring your own key. All adapters work in browser (fetch) and Node/Bun.
 * Swap any time — the interface is just complete(system, user) => string.
 */

import type { LlmAdapter } from "./types.js";

// ── Anthropic Claude ──────────────────────────────────────────────────────────

export interface ClaudeAdapterOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  /** Override API base — useful for proxies */
  baseUrl?: string;
}

export function createClaudeAdapter(opts: ClaudeAdapterOptions): LlmAdapter {
  const base = opts.baseUrl ?? "https://api.anthropic.com";
  const model = opts.model ?? "claude-haiku-4-5-20251001";
  const maxTokens = opts.maxTokens ?? 2048;

  return {
    async complete(system, user, callOpts) {
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
          // Required for browser calls via Anthropic's CORS headers
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model,
          max_tokens: callOpts?.maxTokens ?? maxTokens,
          system,
          messages: [{ role: "user", content: user }],
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(
          `Claude API ${res.status}: ${(err as any).error?.message ?? res.statusText}`,
        );
      }

      const data = await res.json() as {
        content: Array<{ type: string; text: string }>;
      };
      return data.content.find((b) => b.type === "text")?.text ?? "";
    },
  };
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

export interface OpenAiAdapterOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  baseUrl?: string;
}

export function createOpenAiAdapter(opts: OpenAiAdapterOptions): LlmAdapter {
  const base = opts.baseUrl ?? "https://api.openai.com";
  const model = opts.model ?? "gpt-4o-mini";
  const maxTokens = opts.maxTokens ?? 2048;

  return {
    async complete(system, user, callOpts) {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: callOpts?.maxTokens ?? maxTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(
          `OpenAI API ${res.status}: ${(err as any).error?.message ?? res.statusText}`,
        );
      }

      const data = await res.json() as {
        choices: Array<{ message: { content: string } }>;
      };
      return data.choices[0]?.message.content ?? "";
    },
  };
}

// ── Custom / OpenAI-compatible endpoint ───────────────────────────────────────
// Works with Ollama, Groq, Together, Mistral, Workers AI, etc.

export interface CustomAdapterOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  maxTokens?: number;
}

export function createCustomAdapter(opts: CustomAdapterOptions): LlmAdapter {
  return {
    async complete(system, user, callOpts) {
      const res = await fetch(`${opts.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: callOpts?.maxTokens ?? opts.maxTokens ?? 2048,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });

      if (!res.ok) {
        throw new Error(`LLM API ${res.status}: ${res.statusText}`);
      }

      const data = await res.json() as {
        choices: Array<{ message: { content: string } }>;
      };
      return data.choices[0]?.message.content ?? "";
    },
  };
}

/**
 * @openfs/bot-telegram
 *
 * Telegram bot that connects to the OpenFS sync server (port 4322).
 * Every message becomes a wiki query. Commands for grep, cat, ingest, sync.
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN   — BotFather token
 *   OPENFS_API_URL        — sync server (default http://localhost:4322)
 *   ALLOWED_CHAT_IDS      — comma-separated chat IDs (optional, blank = open)
 *   MW_PUBLIC_URL         — MediaWiki public URL (default http://localhost:8082)
 */

import { Bot, Context, InputFile } from "grammy";

const TOKEN       = process.env.TELEGRAM_BOT_TOKEN ?? "";
const API         = process.env.OPENFS_API_URL?.replace(/\/$/, "") ?? "http://localhost:4322";
const MW_URL      = process.env.MW_PUBLIC_URL ?? "http://localhost:8082";
const ALLOWED_IDS = (process.env.ALLOWED_CHAT_IDS ?? "")
  .split(",").map(s => s.trim()).filter(Boolean);

if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set");
  process.exit(1);
}

const bot = new Bot(TOKEN);

// ── Auth guard ────────────────────────────────────────────────────────────────

function allowed(ctx: Context): boolean {
  if (ALLOWED_IDS.length === 0) return true;
  return ALLOWED_IDS.includes(String(ctx.chat?.id));
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function api(path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, body ? {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  } : undefined);
  return res.json() as Promise<any>;
}

function mwLink(title: string) {
  return `${MW_URL}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

// ── Commands ──────────────────────────────────────────────────────────────────

bot.command("start", async ctx => {
  await ctx.reply(
    "🧠 *OpenFS Wiki Bot*\n\n" +
    "I'm connected to your enterprise knowledge base\\. Ask me anything or use a command:\n\n" +
    "/ask _question_ — query the wiki with AI\n" +
    "/grep _term_ — search across all wiki files\n" +
    "/cat _path_ — read a specific page\n" +
    "/pages — list all wiki pages\n" +
    "/recent — recent changes\n" +
    "/ingest _url_ — fetch & synthesize a URL\n" +
    "/sync — trigger recent changes sync\n" +
    "/status — sync server health\n\n" +
    "Or just send a message to ask the wiki\\.",
    { parse_mode: "MarkdownV2" }
  );
});

bot.command("status", async ctx => {
  if (!allowed(ctx)) return;
  try {
    const d = await api("/status");
    const icon = d.ok ? "✅" : "❌";
    const syncing = d.syncRunning ? " _(syncing now)_" : "";
    const lastSync = d.lastSync ? new Date(d.lastSync).toLocaleString() : "never";
    await ctx.reply(
      `${icon} *OpenFS Sync Server*\n\n` +
      `Mapped: *${d.synthesizedCount}* pages\n` +
      `Last sync: ${lastSync}${syncing}\n` +
      `MW: ${d.mwUrl}`,
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    await ctx.reply("❌ Sync server offline. Run: `docker compose up -d agent-wiki-mw`", { parse_mode: "Markdown" });
  }
});

bot.command("ask", async ctx => {
  if (!allowed(ctx)) return;
  const question = ctx.match?.trim();
  if (!question) { await ctx.reply("Usage: /ask your question here"); return; }

  const thinking = await ctx.reply("🤔 Thinking...");
  try {
    const d = await api("/query", { question });
    let reply = `*Q: ${question}*\n\n${d.answer}`;

    if (d.citations?.length) {
      reply += "\n\n*Sources:*";
      for (const c of d.citations.slice(0, 5)) {
        const title = c.replace(/^\/wiki\//, "").replace(/\.md$/, "").replace(/-/g, " ")
          .replace(/\b\w/g, (ch: string) => ch.toUpperCase());
        reply += `\n• [${title}](${mwLink(title)})`;
      }
    }

    await ctx.api.editMessageText(ctx.chat!.id, thinking.message_id, reply, {
      parse_mode: "Markdown",
      link_preview_options: { is_disabled: true },
    });
  } catch (e) {
    await ctx.api.editMessageText(ctx.chat!.id, thinking.message_id,
      `❌ Error: ${(e as Error).message}`);
  }
});

bot.command("grep", async ctx => {
  if (!allowed(ctx)) return;
  const query = ctx.match?.trim();
  if (!query) { await ctx.reply("Usage: /grep search term"); return; }

  const msg = await ctx.reply(`🔍 grep "${query}"...`);
  try {
    const results = await api("/grep", { query, dir: "/wiki" });
    if (!results?.length) {
      await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, `No matches for: *${query}*`, { parse_mode: "Markdown" });
      return;
    }

    let reply = `🔍 *grep "${query}"* — ${results.length} files\n\n`;
    for (const r of results.slice(0, 8)) {
      const name = r.path.replace(/^\/wiki\//, "").replace(/\.md$/, "");
      reply += `📄 \`${name}\`\n`;
      for (const m of r.matches.slice(0, 2)) {
        const line = m.line.length > 80 ? m.line.slice(0, 77) + "..." : m.line;
        reply += `  L${m.num}: ${line}\n`;
      }
      reply += "\n";
    }

    await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, reply, { parse_mode: "Markdown" });
  } catch (e) {
    await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, `❌ ${(e as Error).message}`);
  }
});

bot.command("cat", async ctx => {
  if (!allowed(ctx)) return;
  const path = ctx.match?.trim();
  if (!path) { await ctx.reply("Usage: /cat /wiki/page-name.md"); return; }

  try {
    const d = await api(`/cat?path=${encodeURIComponent(path)}`);
    if (d.error) { await ctx.reply(`❌ ${d.error}`); return; }
    const content = d.content.length > 3500 ? d.content.slice(0, 3500) + "\n\n_(truncated)_" : d.content;
    await ctx.reply(`📄 *${path}*\n\n\`\`\`\n${content}\n\`\`\``, { parse_mode: "Markdown" });
  } catch (e) {
    await ctx.reply(`❌ ${(e as Error).message}`);
  }
});

bot.command("pages", async ctx => {
  if (!allowed(ctx)) return;
  try {
    const pages = await api("/pages");
    const list = pages.slice(0, 30).map((p: any) =>
      `• [${p.title}](${mwLink(p.title)}) _(${Math.round(p.size / 1024 * 10) / 10}kb)_`
    ).join("\n");
    await ctx.reply(`📚 *Wiki Pages (${pages.length} total)*\n\n${list}`, {
      parse_mode: "Markdown",
      link_preview_options: { is_disabled: true },
    });
  } catch (e) {
    await ctx.reply(`❌ ${(e as Error).message}`);
  }
});

bot.command("recent", async ctx => {
  if (!allowed(ctx)) return;
  try {
    const changes = await api("/recent-changes?limit=15");
    const typeIcon: Record<string, string> = { human: "✏️", source: "📖", synthesized: "🤖" };
    const list = changes.slice(0, 15).map((c: any) => {
      const icon = typeIcon[c.type] ?? "📝";
      const ts = new Date(c.timestamp).toLocaleTimeString();
      return `${icon} [${c.title}](${c.mwUrl}) _${ts}_ by ${c.user}`;
    }).join("\n");
    await ctx.reply(`🕐 *Recent Changes*\n\n${list}`, {
      parse_mode: "Markdown",
      link_preview_options: { is_disabled: true },
    });
  } catch (e) {
    await ctx.reply(`❌ ${(e as Error).message}`);
  }
});

bot.command("sync", async ctx => {
  if (!allowed(ctx)) return;
  await api("/sync-recent", {});
  await ctx.reply("⟳ Sync queued — recent changes will be re-ingested.");
});

bot.command("ingest", async ctx => {
  if (!allowed(ctx)) return;
  const input = ctx.match?.trim();
  if (!input) { await ctx.reply("Usage: /ingest https://example.com/page\nor: /ingest Title :: content here"); return; }

  const msg = await ctx.reply("⏳ Ingesting...");
  try {
    let title: string, content: string;

    if (input.startsWith("http")) {
      // Fetch URL content
      const res = await fetch(input);
      const html = await res.text();
      // Very basic HTML → text strip
      content = html.replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ").trim().slice(0, 8000);
      const urlTitle = new URL(input).pathname.split("/").filter(Boolean).pop() ?? "web-page";
      title = urlTitle.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    } else if (input.includes("::")) {
      [title, content] = input.split("::").map(s => s.trim());
    } else {
      title = "Telegram Note";
      content = input;
    }

    const d = await api("/ingest", { title, content });
    const created = (d.pagesCreated ?? []).length;
    const updated = (d.pagesUpdated ?? []).length;
    await ctx.api.editMessageText(ctx.chat!.id, msg.message_id,
      `✅ *Ingested: ${title}*\n\nCreated: ${created} pages · Updated: ${updated} pages`,
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, `❌ ${(e as Error).message}`);
  }
});

// ── Plain messages → /ask ─────────────────────────────────────────────────────

bot.on("message:text", async ctx => {
  if (!allowed(ctx)) return;
  if (ctx.message.text.startsWith("/")) return; // handled by commands

  const question = ctx.message.text.trim();
  if (question.length < 3) return;

  const thinking = await ctx.reply("🤔 ...");
  try {
    const d = await api("/query", { question });
    let reply = d.answer ?? "No answer.";
    if (d.citations?.length) {
      reply += "\n\n_Sources: " + d.citations.slice(0, 3).map((c: string) => {
        const t = c.replace(/^\/wiki\//, "").replace(/\.md$/, "").replace(/-/g, " ")
          .replace(/\b\w/g, (ch: string) => ch.toUpperCase());
        return t;
      }).join(", ") + "_";
    }
    await ctx.api.editMessageText(ctx.chat!.id, thinking.message_id, reply, {
      parse_mode: "Markdown",
      link_preview_options: { is_disabled: true },
    });
  } catch {
    await ctx.api.editMessageText(ctx.chat!.id, thinking.message_id,
      "❌ Could not reach OpenFS sync server.");
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

console.log(`[openfs-bot] Starting Telegram bot, API=${API}`);
bot.start({
  onStart: info => console.log(`[openfs-bot] @${info.username} running`),
});

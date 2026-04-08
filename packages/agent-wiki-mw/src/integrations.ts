/**
 * OpenFS Integration Manager
 *
 * Manages connections to SharePoint, Jira, and Slack.
 * Fetches content from each source and ingests it into OpenFS
 * at /sources/sharepoint/, /sources/jira/, /sources/slack/
 */

import { Database } from "bun:sqlite";

export type IntegrationType = "sharepoint" | "jira" | "slack";
export type IntegrationStatus = "pending" | "connected" | "syncing" | "error";

export interface Integration {
  id: string;
  type: IntegrationType;
  name: string;
  config: Record<string, string>;
  status: IntegrationStatus;
  last_sync: string | null;
  doc_count: number;
  error_msg: string | null;
  created_at: string;
}

export interface SyncDoc {
  path: string;
  content: string;
  title: string;
  url?: string;
}

// ── DB ────────────────────────────────────────────────────────────────────────

export function initIntegrationsDb(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS integrations (
      id         TEXT PRIMARY KEY,
      type       TEXT NOT NULL,
      name       TEXT NOT NULL,
      config     TEXT NOT NULL DEFAULT '{}',
      status     TEXT NOT NULL DEFAULT 'pending',
      last_sync  TEXT,
      doc_count  INTEGER NOT NULL DEFAULT 0,
      error_msg  TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS integration_docs (
      id             TEXT PRIMARY KEY,
      integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
      path           TEXT NOT NULL,
      title          TEXT,
      source_url     TEXT,
      size_bytes     INTEGER,
      mime_type      TEXT,
      synced_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS integration_logs (
      id             TEXT PRIMARY KEY,
      integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
      ts             TEXT NOT NULL DEFAULT (datetime('now')),
      level          TEXT NOT NULL DEFAULT 'info',
      message        TEXT NOT NULL
    )
  `);
}

// ── SharePoint ────────────────────────────────────────────────────────────────
//
// Required Azure app registration permissions (Application, not Delegated):
//   - Sites.Read.All       (read SharePoint sites + drives)
//   - Files.Read.All       (read drive items + content)
//
// Setup steps:
//   1. Azure Portal → App registrations → New registration
//   2. API permissions → Add → Microsoft Graph → Application → Sites.Read.All + Files.Read.All
//   3. Grant admin consent
//   4. Certificates & secrets → New client secret → copy value
//   5. Overview → copy Application (client) ID + Directory (tenant) ID

interface SharePointConfig {
  tenant_id:     string;  // Azure AD Directory (tenant) ID
  client_id:     string;  // App registration Application (client) ID
  client_secret: string;  // App registration client secret value
  site_url:      string;  // https://company.sharepoint.com/sites/mysite
  drive_name?:   string;  // optional: specific document library name (default: all)
}

async function getSharePointToken(cfg: SharePointConfig): Promise<string> {
  const res = await fetch(
    `https://login.microsoftonline.com/${cfg.tenant_id}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "client_credentials",
        client_id:     cfg.client_id,
        client_secret: cfg.client_secret,
        scope:         "https://graph.microsoft.com/.default",
      }),
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as any;
    const desc = body.error_description ?? body.error ?? await res.text();
    throw new Error(`SharePoint auth failed (${res.status}): ${desc}`);
  }
  const data = await res.json() as any;
  if (!data.access_token) throw new Error("No access_token in SharePoint auth response");
  return data.access_token;
}

async function getSharePointSiteId(token: string, siteUrl: string): Promise<string> {
  const u        = new URL(siteUrl);
  const hostname = u.hostname;
  const sitePath = u.pathname.replace(/\/$/, "");
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${hostname}:${sitePath}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as any;
    throw new Error(`Could not resolve SharePoint site "${siteUrl}": ${body.error?.message ?? res.status}. Ensure Sites.Read.All is granted.`);
  }
  const data = await res.json() as any;
  return data.id;
}

async function listSharePointDrives(token: string, siteId: string): Promise<{ id: string; name: string }[]> {
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${siteId}/drives?$select=id,name`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return [];
  const data = await res.json() as any;
  return (data.value || []).map((d: any) => ({ id: d.id, name: d.name }));
}

// Recursively walk a drive folder, returning all file items (text extraction only)
async function walkDriveFolder(token: string, folderUrl: string, depth = 0): Promise<any[]> {
  if (depth > 5) return []; // safety cap
  const res = await fetch(
    `${folderUrl}?$select=id,name,file,folder,size,webUrl,lastModifiedDateTime&$top=200`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return [];
  const data = await res.json() as any;
  const items = data.value || [];
  const files: any[] = [];
  for (const item of items) {
    if (item.file) {
      files.push(item);
    } else if (item.folder) {
      const childUrl = `https://graph.microsoft.com/v1.0/drives/${item.parentReference?.driveId}/items/${item.id}/children`;
      const children = await walkDriveFolder(token, childUrl, depth + 1);
      files.push(...children);
    }
  }
  return files;
}

// List one level of a drive folder (no recursion) — for browser navigation
async function listFolderItems(token: string, driveId: string, folderId: string): Promise<any[]> {
  const url = folderId === "root"
    ? `https://graph.microsoft.com/v1.0/drives/${driveId}/root/children`
    : `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${folderId}/children`;
  const res = await fetch(
    `${url}?$select=id,name,file,folder,size,webUrl,lastModifiedDateTime,parentReference&$top=500`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return [];
  const data = await res.json() as any;
  return (data.value || []).map((item: any) => ({
    id:       item.id,
    name:     item.name,
    isFolder: !!item.folder,
    size:     item.size ?? 0,
    webUrl:   item.webUrl,
    modified: item.lastModifiedDateTime?.slice(0, 10) ?? "",
    driveId,
    mimeType: item.file?.mimeType ?? (item.folder ? "folder" : ""),
    childCount: item.folder?.childCount ?? 0,
  }));
}

// Extract readable text from a downloaded file buffer
async function extractFileText(token: string, driveId: string, itemId: string, name: string, ct: string): Promise<string> {
  // For plain text types, just read as text (avoid binary download)
  if (
    ct.includes("text/") ||
    ct.includes("application/json") ||
    name.endsWith(".md") ||
    name.endsWith(".txt") ||
    name.endsWith(".csv") ||
    name.endsWith(".html") ||
    name.endsWith(".htm")
  ) {
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/content`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return res.ok ? await res.text() : "";
  }

  // For Word .docx — use Graph's built-in text extraction (beta endpoint)
  if (name.endsWith(".docx") || name.endsWith(".doc")) {
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/content?format=text`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.ok) return await res.text();
    // Fallback: try downloading raw and extracting XML content
    const raw = await fetch(
      `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/content`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!raw.ok) return "";
    // Pull text nodes from docx XML (good enough for indexing)
    const buf  = await raw.text();
    const text = buf.replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim();
    return text.slice(0, 50000);
  }

  // PDF / XLSX / PPTX / other binary — download raw bytes and extract via file-extractor
  const dlRes = await fetch(
    `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/content`,
    { headers: { Authorization: `Bearer ${token}` }, redirect: "follow" }
  );
  if (!dlRes.ok) return "";
  const bytes = await dlRes.arrayBuffer();
  const { extractText } = await import("../../agent-knowledge/src/file-extractor.js");
  return extractText(new Uint8Array(bytes), name, ct);
}

export async function fetchSharePoint(cfg: SharePointConfig): Promise<SyncDoc[]> {
  const token  = await getSharePointToken(cfg);
  const siteId = await getSharePointSiteId(token, cfg.site_url);

  // Get all document libraries (drives), optionally filtered by name
  let drives = await listSharePointDrives(token, siteId);
  if (cfg.drive_name) {
    drives = drives.filter(d => d.name.toLowerCase() === cfg.drive_name!.toLowerCase());
    if (!drives.length) throw new Error(`Document library "${cfg.drive_name}" not found on site`);
  }

  const SUPPORTED = [".md", ".txt", ".html", ".htm", ".csv", ".json", ".docx", ".doc", ".xlsx", ".xls", ".pdf", ".pptx", ".ppt"];
  const docs: SyncDoc[] = [];

  for (const drive of drives) {
    const rootUrl = `https://graph.microsoft.com/v1.0/drives/${drive.id}/root/children`;
    const items   = await walkDriveFolder(token, rootUrl);

    for (const item of items) {
      const name = item.name as string;
      const ext  = name.slice(name.lastIndexOf(".")).toLowerCase();
      if (!SUPPORTED.includes(ext)) continue;
      if ((item.size ?? 0) > 5_000_000) continue; // skip >5MB

      try {
        const downloadRes = await fetch(
          `https://graph.microsoft.com/v1.0/drives/${drive.id}/items/${item.id}/content`,
          { headers: { Authorization: `Bearer ${token}` }, redirect: "follow" }
        );
        if (!downloadRes.ok) continue;
        const ct      = downloadRes.headers.get("content-type") || "";
        const content = await extractFileText(token, drive.id, item.id, name, ct);
        if (!content.trim()) continue;

        const slug = `${drive.name}-${name}`.toLowerCase().replace(/[^a-z0-9.]+/g, "-");
        docs.push({
          path:    `/sources/sharepoint/${slug}`,
          title:   `${drive.name} / ${name}`,
          content: [
            `# ${name}`,
            ``,
            `| Field | Value |`,
            `|---|---|`,
            `| **Library** | ${drive.name} |`,
            `| **Site** | ${cfg.site_url} |`,
            `| **Modified** | ${item.lastModifiedDateTime?.slice(0, 10) ?? "—"} |`,
            `| **Source** | [Open in SharePoint](${item.webUrl}) |`,
            ``,
            content,
          ].join("\n"),
          url: item.webUrl,
        });
      } catch { /* skip unreadable */ }
    }
  }
  return docs;
}

// ── Jira ──────────────────────────────────────────────────────────────────────

interface JiraConfig {
  base_url:     string;  // https://company.atlassian.net
  email:        string;
  api_token:    string;
  project_keys: string;  // comma-separated e.g. "PROJ,TEAM"
}

function jiraAuth(cfg: JiraConfig): string {
  return "Basic " + btoa(`${cfg.email}:${cfg.api_token}`);
}

export async function fetchJira(cfg: JiraConfig): Promise<SyncDoc[]> {
  const auth     = jiraAuth(cfg);
  const projects = cfg.project_keys.split(",").map(s => s.trim()).filter(Boolean);
  const jql      = projects.length
    ? `project in (${projects.map(p => `"${p}"`).join(",")}) ORDER BY updated DESC`
    : `ORDER BY updated DESC`;

  const res = await fetch(
    `${cfg.base_url}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=100&fields=summary,description,status,assignee,priority,created,updated,comment,issuetype`,
    { headers: { Authorization: auth, Accept: "application/json" } }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Jira search failed (${res.status}): ${err.slice(0, 200)}`);
  }
  const data = await res.json() as any;
  const issues = data.issues || [];

  return issues.map((issue: any): SyncDoc => {
    const f    = issue.fields;
    const key  = issue.key;
    const desc = extractJiraText(f.description) || "_No description_";
    const comments = (f.comment?.comments || []).slice(0, 10).map((c: any) =>
      `**${c.author?.displayName ?? "Unknown"}** (${c.created?.slice(0, 10) ?? ""}):\n${extractJiraText(c.body)}`
    ).join("\n\n");

    const md = [
      `# [${key}] ${f.summary}`,
      ``,
      `| Field | Value |`,
      `|---|---|`,
      `| **Type** | ${f.issuetype?.name ?? "-"} |`,
      `| **Status** | ${f.status?.name ?? "-"} |`,
      `| **Priority** | ${f.priority?.name ?? "-"} |`,
      `| **Assignee** | ${f.assignee?.displayName ?? "Unassigned"} |`,
      `| **Created** | ${f.created?.slice(0, 10) ?? "-"} |`,
      `| **Updated** | ${f.updated?.slice(0, 10) ?? "-"} |`,
      ``,
      `## Description`,
      desc,
      comments ? `\n## Comments\n\n${comments}` : "",
    ].join("\n");

    return {
      path:    `/sources/jira/${key.toLowerCase()}.md`,
      title:   `[${key}] ${f.summary}`,
      content: md,
      url:     `${cfg.base_url}/browse/${key}`,
    };
  });
}

function extractJiraText(adf: any): string {
  if (!adf) return "";
  if (typeof adf === "string") return adf;
  if (adf.type === "text") return adf.text ?? "";
  if (Array.isArray(adf.content)) return adf.content.map(extractJiraText).join(" ");
  return "";
}

// ── Slack ─────────────────────────────────────────────────────────────────────

interface SlackConfig {
  bot_token:   string;  // xoxb-...
  channel_ids: string;  // comma-separated channel IDs or names
}

async function slackGet(token: string, path: string, params: Record<string, string> = {}): Promise<any> {
  const qs  = new URLSearchParams(params).toString();
  const res = await fetch(`https://slack.com/api/${path}${qs ? "?" + qs : ""}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json() as any;
  if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
  return data;
}

export async function fetchSlack(cfg: SlackConfig): Promise<SyncDoc[]> {
  const token    = cfg.bot_token;
  const ids      = cfg.channel_ids.split(",").map(s => s.trim()).filter(Boolean);
  const docs: SyncDoc[] = [];

  // Resolve channel names → IDs
  let allChannels: any[] = [];
  try {
    const r = await slackGet(token, "conversations.list", { types: "public_channel,private_channel", limit: "200" });
    allChannels = r.channels || [];
  } catch {}

  const resolvedIds = ids.map(id => {
    if (id.startsWith("C")) return id; // already an ID
    const found = allChannels.find((c: any) => c.name === id || c.name_normalized === id);
    return found?.id ?? id;
  });

  for (const channelId of resolvedIds) {
    try {
      const info = allChannels.find((c: any) => c.id === channelId);
      const name = info?.name ?? channelId;

      const hist = await slackGet(token, "conversations.history", {
        channel: channelId,
        limit:   "100",
      });
      const messages = hist.messages || [];

      // Group into threads
      const topLevel = messages.filter((m: any) => !m.thread_ts || m.thread_ts === m.ts);

      const sections = await Promise.all(topLevel.map(async (msg: any) => {
        const user = msg.user ? `<@${msg.user}>` : "Bot";
        const time = msg.ts ? new Date(parseFloat(msg.ts) * 1000).toISOString().slice(0, 16).replace("T", " ") : "";
        let text   = `**${user}** (${time}):\n${msg.text || ""}`;

        if (msg.reply_count && msg.thread_ts) {
          try {
            const thread = await slackGet(token, "conversations.replies", {
              channel: channelId,
              ts:      msg.thread_ts,
              limit:   "20",
            });
            const replies = (thread.messages || []).slice(1);
            for (const r of replies) {
              const ru = r.user ? `<@${r.user}>` : "Bot";
              const rt = r.ts ? new Date(parseFloat(r.ts) * 1000).toISOString().slice(0, 16).replace("T", " ") : "";
              text += `\n  > **${ru}** (${rt}): ${r.text || ""}`;
            }
          } catch {}
        }
        return text;
      }));

      const md = [
        `# #${name} — Slack Archive`,
        ``,
        `_Source: Slack channel #${name} (${channelId})_`,
        `_Synced: ${new Date().toISOString().slice(0, 10)}_`,
        ``,
        `## Messages`,
        ``,
        sections.join("\n\n---\n\n"),
      ].join("\n");

      docs.push({
        path:    `/sources/slack/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`,
        title:   `#${name}`,
        content: md,
        url:     `https://slack.com/app_redirect?channel=${channelId}`,
      });
    } catch (e) {
      console.warn(`[integrations] Slack channel ${channelId} failed:`, (e as Error).message);
    }
  }
  return docs;
}

// ── S3 / adapter-s3-api helpers ───────────────────────────────────────────────
//
// All S3 ops go through the adapter-s3-api FastAPI service (MINIO_API_URL).
// Endpoints used:
//   POST /api/v1/buckets/                              — create bucket
//   POST /api/v1/objects/upload/{bucket}?object_name= — binary multipart upload
//   POST /api/v1/objects/put/{bucket}                 — text/JSON upload
//   GET  /api/v1/objects/list/{bucket}?recursive=true — list all objects
//   GET  /api/v1/objects/download/{bucket}?object_name= — download object bytes

function s3ApiUrl(): string {
  return (process.env.MINIO_API_URL ?? "http://localhost:8080").replace(/\/$/, "");
}

const S3_AUTH = { Authorization: "Bearer demo-token" };

/** Create bucket — ignore 400 "already exists" */
async function s3EnsureBucket(bucket: string): Promise<void> {
  const res = await fetch(`${s3ApiUrl()}/api/v1/buckets/`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", ...S3_AUTH },
    body:    JSON.stringify({ name: bucket }),
  });
  if (!res.ok && res.status !== 400) {
    const err = await res.text().catch(() => "");
    throw new Error(`Bucket create failed (${res.status}): ${err.slice(0, 200)}`);
  }
}

/** Upload raw binary file via multipart form */
async function s3UploadBinary(bucket: string, key: string, bytes: ArrayBuffer, contentType: string): Promise<void> {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: contentType }), key.split("/").pop() ?? "file");
  const res = await fetch(
    `${s3ApiUrl()}/api/v1/objects/upload/${encodeURIComponent(bucket)}?object_name=${encodeURIComponent(key)}`,
    { method: "POST", headers: { ...S3_AUTH }, body: form }
  );
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`S3 upload failed (${res.status}): ${err.slice(0, 200)}`);
  }
}

/** Upload text / JSON content */
async function s3PutText(bucket: string, key: string, content: string, contentType = "text/plain; charset=utf-8"): Promise<void> {
  const res = await fetch(`${s3ApiUrl()}/api/v1/objects/put/${encodeURIComponent(bucket)}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", ...S3_AUTH },
    body:    JSON.stringify({ key, content, content_type: contentType }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`S3 put-text failed (${res.status}): ${err.slice(0, 200)}`);
  }
}

/** List all objects in a bucket (recursive) */
async function s3ListObjects(bucket: string, prefix = ""): Promise<{ name: string; size: number; last_modified: string }[]> {
  const qs  = prefix ? `?prefix=${encodeURIComponent(prefix)}&recursive=true` : "?recursive=true";
  const res = await fetch(`${s3ApiUrl()}/api/v1/objects/list/${encodeURIComponent(bucket)}${qs}`, { headers: S3_AUTH });
  if (!res.ok) return [];
  return res.json();
}

/** Download an object as bytes */
async function s3Download(bucket: string, key: string): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
  const res = await fetch(
    `${s3ApiUrl()}/api/v1/objects/download/${encodeURIComponent(bucket)}?object_name=${encodeURIComponent(key)}`,
    { headers: S3_AUTH }
  );
  if (!res.ok) return null;
  const bytes = await res.arrayBuffer();
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  return { bytes, contentType };
}

function slugifyBucketName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 63);
}

// ── Text extraction for S3-stored files ──────────────────────────────────────
// Delegates to the shared file-extractor module (PDF/DOCX/XLSX/plain text).

async function extractS3FileText(bytes: ArrayBuffer, name: string, contentType: string): Promise<string> {
  const { extractText } = await import("../../agent-knowledge/src/file-extractor.js");
  return extractText(new Uint8Array(bytes), name, contentType);
}

// ── Integration manager ───────────────────────────────────────────────────────

export class IntegrationManager {
  constructor(private db: Database) {
    initIntegrationsDb(db);
    // Migrate existing integration_docs table to add new columns if missing
    try {
      this.db.run("ALTER TABLE integration_docs ADD COLUMN size_bytes INTEGER");
      this.db.run("ALTER TABLE integration_docs ADD COLUMN mime_type TEXT");
    } catch { /* columns already exist */ }
  }

  list(): Integration[] {
    return this.db.query("SELECT * FROM integrations ORDER BY created_at DESC")
      .all()
      .map((r: any) => this.parse(r));
  }

  get(id: string): Integration | null {
    const row = this.db.query("SELECT * FROM integrations WHERE id = ?").get(id) as any;
    return row ? this.parse(row) : null;
  }

  create(type: IntegrationType, name: string, config: Record<string, string>): Integration {
    const id = crypto.randomUUID();
    this.db.run(
      "INSERT INTO integrations (id, type, name, config) VALUES (?, ?, ?, ?)",
      [id, type, name, JSON.stringify(config)]
    );
    return this.get(id)!;
  }

  update(id: string, fields: Partial<{ name: string; config: Record<string, string> }>): void {
    if (fields.name) this.db.run("UPDATE integrations SET name = ? WHERE id = ?", [fields.name, id]);
    if (fields.config) this.db.run("UPDATE integrations SET config = ? WHERE id = ?", [JSON.stringify(fields.config), id]);
  }

  delete(id: string): void {
    this.db.run("DELETE FROM integrations WHERE id = ?", [id]);
  }

  // ── Logging ──────────────────────────────────────────────────────────────

  addLog(id: string, message: string, level: "info" | "warn" | "error" | "ok" = "info"): void {
    this.db.run(
      "INSERT INTO integration_logs (id, integration_id, level, message) VALUES (?, ?, ?, ?)",
      [crypto.randomUUID(), id, level, message]
    );
  }

  getLogs(id: string, limit = 100): { ts: string; level: string; message: string }[] {
    return this.db.query(
      "SELECT ts, level, message FROM integration_logs WHERE integration_id = ? ORDER BY ts DESC LIMIT ?"
    ).all(id, limit) as any[];
  }

  // ── Docs ─────────────────────────────────────────────────────────────────

  listDocs(id: string): { path: string; title: string; source_url: string; size_bytes: number; mime_type: string; synced_at: string }[] {
    return this.db.query(
      "SELECT path, title, source_url, size_bytes, mime_type, synced_at FROM integration_docs WHERE integration_id = ? ORDER BY path ASC"
    ).all(id) as any[];
  }

  /** Returns a hierarchical tree structure of ingested docs */
  getTree(id: string): any {
    const docs = this.listDocs(id);
    const root: any = { name: "/", children: {}, files: [] };
    for (const doc of docs) {
      const parts = doc.path.replace(/^\//, "").split("/");
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!node.children[part]) node.children[part] = { name: part, children: {}, files: [] };
        node = node.children[part];
      }
      node.files.push({
        name: parts[parts.length - 1],
        path: doc.path,
        title: doc.title,
        url: doc.source_url,
        size: doc.size_bytes,
        synced_at: doc.synced_at,
      });
    }
    const toArray = (node: any): any => ({
      name: node.name,
      files: node.files,
      children: Object.values(node.children).map(toArray),
    });
    return toArray(root);
  }

  // ── SharePoint libraries ──────────────────────────────────────────────────

  async listLibraries(id: string): Promise<{ id: string; name: string; description: string }[]> {
    const integration = this.get(id);
    if (!integration || integration.type !== "sharepoint") throw new Error("Not a SharePoint integration");
    const cfg = integration.config as any;
    const token  = await getSharePointToken(cfg);
    const siteId = await getSharePointSiteId(token, cfg.site_url);
    const drives = await listSharePointDrives(token, siteId);
    return drives.map(d => ({ id: d.id, name: d.name, description: "" }));
  }

  // ── Browse SharePoint folder (one level, all file types) ─────────────────

  async browse(id: string, driveId?: string, folderId = "root"): Promise<{
    drives: { id: string; name: string }[];
    items: any[];
    driveId: string | null;
    folderId: string;
  }> {
    const integration = this.get(id);
    if (!integration || integration.type !== "sharepoint") throw new Error("Not a SharePoint integration");
    const cfg    = integration.config as any;
    const token  = await getSharePointToken(cfg);
    const siteId = await getSharePointSiteId(token, cfg.site_url);
    const drives = await listSharePointDrives(token, siteId);

    // Filter out system libraries (Style Library, Site Assets, etc.)
    const userDrives = drives.filter(d =>
      !["Style Library", "Site Assets", "FormServerTemplates", "Master Page Gallery"].includes(d.name)
    );

    if (!driveId) {
      return { drives: userDrives, items: [], driveId: null, folderId: "root" };
    }

    const items = await listFolderItems(token, driveId, folderId);
    return { drives: userDrives, items, driveId, folderId };
  }

  // ── Push raw files from SharePoint → S3 ──────────────────────────────────

  async pushRawToS3(
    id: string,
    files: Array<{ driveId: string; itemId: string; name: string; s3Path: string }>
  ): Promise<{ bucket: string; uploaded: number; skipped: number; errors: string[] }> {
    const integration = this.get(id);
    if (!integration) throw new Error(`Integration ${id} not found`);

    const cfg    = integration.config as any;
    const token  = await getSharePointToken(cfg);
    const bucket = slugifyBucketName(`openfs-${integration.name}`);
    const errors: string[] = [];
    let uploaded = 0;
    let skipped  = 0;

    this.addLog(id, `S3 push started → ${files.length} files → bucket: ${bucket}`);

    // Ensure bucket exists
    try {
      await s3EnsureBucket(bucket);
      this.addLog(id, `Bucket ready: ${bucket}`, "ok");
    } catch (e) {
      this.addLog(id, `Bucket create error: ${(e as Error).message}`, "warn");
    }

    for (const file of files) {
      try {
        // Download raw bytes from SharePoint
        const dlRes = await fetch(
          `https://graph.microsoft.com/v1.0/drives/${file.driveId}/items/${file.itemId}/content`,
          { headers: { Authorization: `Bearer ${token}` }, redirect: "follow" }
        );
        if (!dlRes.ok) {
          skipped++;
          this.addLog(id, `Skip (SP download ${dlRes.status}): ${file.name}`, "warn");
          continue;
        }

        const bytes       = await dlRes.arrayBuffer();
        const ct          = dlRes.headers.get("content-type") || "application/octet-stream";
        const s3Key       = file.s3Path.replace(/^\//, "");

        // Upload raw file
        await s3UploadBinary(bucket, s3Key, bytes, ct);
        uploaded++;
        this.addLog(id, `✓ ${file.name} → s3://${bucket}/${s3Key}`, "ok");

        // Upload sidecar metadata JSON
        const metaKey  = s3Key + ".meta.json";
        const metadata = {
          name:            file.name,
          driveId:         file.driveId,
          itemId:          file.itemId,
          s3Key,
          mimeType:        ct,
          sizeBytes:       bytes.byteLength,
          uploadedAt:      new Date().toISOString(),
          source:          "sharepoint",
          integrationId:   id,
          integrationName: integration.name,
        };
        await s3PutText(bucket, metaKey, JSON.stringify(metadata, null, 2), "application/json");
      } catch (e) {
        const msg = (e as Error).message;
        errors.push(`${file.name}: ${msg}`);
        this.addLog(id, `Error: ${file.name}: ${msg}`, "error");
      }
    }

    this.addLog(
      id,
      `S3 push done: ${uploaded} uploaded, ${skipped} skipped, ${errors.length} errors`,
      uploaded > 0 ? "ok" : "warn"
    );
    return { bucket, uploaded, skipped, errors };
  }

  // ── Sync ─────────────────────────────────────────────────────────────────

  async sync(id: string, agentFs: any): Promise<{ synced: number; errors: string[] }> {
    const integration = this.get(id);
    if (!integration) throw new Error(`Integration ${id} not found`);

    this.db.run("UPDATE integrations SET status = 'syncing', error_msg = NULL WHERE id = ?", [id]);
    this.addLog(id, `Starting sync for ${integration.name}…`);

    const errors: string[] = [];
    let docs: SyncDoc[] = [];

    try {
      const cfg = integration.config as any;
      this.addLog(id, `Fetching from ${integration.type}…`);
      if (integration.type === "sharepoint") {
        docs = await fetchSharePoint(cfg);
      } else if (integration.type === "jira") {
        docs = await fetchJira(cfg);
      } else if (integration.type === "slack") {
        docs = await fetchSlack(cfg);
      }
      this.addLog(id, `Fetched ${docs.length} document(s) from source`, "ok");
    } catch (e) {
      const msg = (e as Error).message;
      this.db.run("UPDATE integrations SET status = 'error', error_msg = ? WHERE id = ?", [msg, id]);
      this.addLog(id, `Fetch failed: ${msg}`, "error");
      throw e;
    }

    // Remove old docs
    const oldPaths = this.db.query(
      "SELECT path FROM integration_docs WHERE integration_id = ?"
    ).all(id).map((r: any) => r.path);
    for (const p of oldPaths) {
      try { await agentFs.remove(p); } catch {}
    }
    this.db.run("DELETE FROM integration_docs WHERE integration_id = ?", [id]);

    // Ingest new docs
    let ingested = 0;
    for (const doc of docs) {
      try {
        await agentFs.ingest({ [doc.path]: doc.content });
        const sizeBytes = new TextEncoder().encode(doc.content).length;
        const mimeType  = doc.path.endsWith(".md") ? "text/markdown" : "text/plain";
        this.db.run(
          "INSERT INTO integration_docs (id, integration_id, path, title, source_url, size_bytes, mime_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [crypto.randomUUID(), id, doc.path, doc.title, doc.url ?? null, sizeBytes, mimeType]
        );
        ingested++;
        this.addLog(id, `Ingested: ${doc.title ?? doc.path}`, "ok");
      } catch (e) {
        const msg = `${doc.path}: ${(e as Error).message}`;
        errors.push(msg);
        this.addLog(id, msg, "error");
      }
    }

    this.db.run(
      "UPDATE integrations SET status = 'connected', last_sync = datetime('now'), doc_count = ?, error_msg = NULL WHERE id = ?",
      [ingested, id]
    );
    this.addLog(id, `Sync complete: ${ingested} docs ingested${errors.length ? `, ${errors.length} errors` : ""}`, ingested > 0 ? "ok" : "warn");

    return { synced: ingested, errors };
  }

  // ── S3 sync (ingested docs → S3 as text) ─────────────────────────────────

  async syncToS3(id: string, agentFs: any): Promise<{ bucket: string; uploaded: number; errors: string[] }> {
    const integration = this.get(id);
    if (!integration) throw new Error(`Integration ${id} not found`);

    const bucket = slugifyBucketName(`openfs-${integration.name}`);
    const errors: string[] = [];
    this.addLog(id, `S3 sync (ingested docs) → bucket: ${bucket}`);

    try {
      await s3EnsureBucket(bucket);
      this.addLog(id, `Bucket ready: ${bucket}`, "ok");
    } catch (e) {
      this.addLog(id, `Bucket create error: ${(e as Error).message}`, "warn");
    }

    const docs = this.listDocs(id);
    let uploaded = 0;

    for (const doc of docs) {
      try {
        const content = await agentFs.read(doc.path);
        if (!content?.trim()) continue;
        const key = doc.path.replace(/^\//, "");
        await s3PutText(bucket, key, content, "text/markdown; charset=utf-8");
        uploaded++;
        this.addLog(id, `✓ ${key}`, "ok");
      } catch (e) {
        const msg = `${doc.path}: ${(e as Error).message}`;
        errors.push(msg);
        this.addLog(id, msg, "error");
      }
    }

    this.addLog(id, `S3 sync complete: ${uploaded}/${docs.length} uploaded`, uploaded > 0 ? "ok" : "warn");
    return { bucket, uploaded, errors };
  }

  // ── Ingest from S3 → Chroma ──────────────────────────────────────────────
  // Reads raw files from the S3 bucket (uploaded via Browse & Push),
  // extracts text from supported types, chunks and embeds into Chroma.

  async ingestFromS3(id: string): Promise<{ bucket: string; embedded: number; skipped: number; errors: string[] }> {
    const integration = this.get(id);
    if (!integration) throw new Error(`Integration ${id} not found`);

    const bucket  = slugifyBucketName(`openfs-${integration.name}`);
    const errors: string[] = [];
    let embedded  = 0;
    let skipped   = 0;

    this.addLog(id, `S3→Chroma ingestion starting from bucket: ${bucket}`);

    const { ChromaStore }   = await import("../../agent-knowledge/src/index.js");
    const { chunkDocument } = await import("../../agent-knowledge/src/chunker.js");

    const store = new ChromaStore({
      collection: "openfs-knowledge",
      chromaUrl:  process.env.CHROMA_URL ?? "http://localhost:8000",
    });
    await store.init();

    // List all objects (skip .meta.json sidecars)
    const objects = await s3ListObjects(bucket);
    const files   = objects.filter(o => !o.name.endsWith(".meta.json"));
    this.addLog(id, `Found ${files.length} files in s3://${bucket}`);

    for (const obj of files) {
      try {
        const dl = await s3Download(bucket, obj.name);
        if (!dl) { skipped++; continue; }

        const { bytes, contentType } = dl;
        const name = obj.name.split("/").pop() ?? obj.name;
        const text = await extractS3FileText(bytes, name, contentType);

        if (!text?.trim()) {
          skipped++;
          this.addLog(id, `Skip (no text extracted): ${obj.name}`, "warn");
          continue;
        }

        const title  = name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
        const chunks = chunkDocument(
          `s3://${bucket}/${obj.name}`, title, text,
          { chunkSize: 1200, overlap: 200 }
        ).map((c: any) => ({ ...c, topic: `integration:${integration.type}:s3` }));

        await store.upsertChunks(chunks);
        embedded++;
        this.addLog(id, `✓ Embedded: ${obj.name} (${chunks.length} chunks)`, "ok");
      } catch (e) {
        const msg = `${obj.name}: ${(e as Error).message}`;
        errors.push(msg);
        this.addLog(id, msg, "error");
      }
    }

    this.addLog(
      id,
      `S3→Chroma done: ${embedded} embedded, ${skipped} skipped, ${errors.length} errors`,
      embedded > 0 ? "ok" : "warn"
    );
    return { bucket, embedded, skipped, errors };
  }

  // ── Embed ─────────────────────────────────────────────────────────────────

  async embedDocs(id: string, agentFs: any): Promise<{ embedded: number; errors: string[] }> {
    const integration = this.get(id);
    if (!integration) throw new Error(`Integration ${id} not found`);

    this.addLog(id, `Starting Chroma embedding for ${integration.name}…`);
    const { ChromaStore }   = await import("../../agent-knowledge/src/index.js");
    const { chunkDocument } = await import("../../agent-knowledge/src/chunker.js");

    const store = new ChromaStore({
      collection: "openfs-knowledge",
      chromaUrl:  process.env.CHROMA_URL ?? "http://localhost:8000",
    });
    await store.init();

    const docs    = this.listDocs(id);
    const errors: string[] = [];
    let embedded  = 0;

    for (const doc of docs) {
      try {
        const content = await agentFs.read(doc.path);
        if (!content?.trim()) continue;
        const chunks = chunkDocument(doc.path, doc.title ?? doc.path, content, { chunkSize: 1200, overlap: 200 })
          .map((c: any) => ({ ...c, topic: `integration:${integration.type}` }));
        await store.upsertChunks(chunks);
        embedded++;
        this.addLog(id, `Embedded: ${doc.title ?? doc.path} (${chunks.length} chunks)`, "ok");
      } catch (e) {
        const msg = `${doc.path}: ${(e as Error).message}`;
        errors.push(msg);
        this.addLog(id, msg, "error");
      }
    }

    this.addLog(id, `Embedding complete: ${embedded} docs embedded into Chroma`, embedded > 0 ? "ok" : "warn");
    return { embedded, errors };
  }

  private parse(row: any): Integration {
    return {
      ...row,
      config: JSON.parse(row.config || "{}"),
    };
  }
}

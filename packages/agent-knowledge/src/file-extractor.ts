/**
 * file-extractor.ts
 *
 * Extracts plain text from binary document formats so they can be
 * chunked + embedded into Chroma like any other text file.
 *
 * Parsers:
 *   PDF  → @llamaindex/liteparse  (OCR-capable, layout-preserving ASCII)
 *   DOCX → mammoth                (clean markdown-ish output)
 *   XLSX → SheetJS                (per-sheet CSV — LLMs read this natively)
 *   text → TextDecoder            (utf-8 passthrough)
 *
 * Usage:
 *   import { extractText } from "./file-extractor.js";
 *   const text = await extractText(bytes, "report.xlsx");
 */

const PLAIN_TEXT_EXTS = new Set([
  ".txt", ".md", ".mdx", ".rst", ".csv", ".log",
  ".json", ".yaml", ".yml", ".html", ".htm",
]);

const PLAIN_TEXT_MIME_PREFIXES = ["text/", "application/json"];

function isPlainText(filename: string, contentType: string): boolean {
  const ext = extOf(filename);
  if (PLAIN_TEXT_EXTS.has(ext)) return true;
  return PLAIN_TEXT_MIME_PREFIXES.some(p => contentType.startsWith(p));
}

function extOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

// ── XLSX via SheetJS ──────────────────────────────────────────────────────────
// SpreadsheetLLM-inspired approach: expand merged cells, detect real header row,
// emit markdown tables. LLMs understand markdown tables natively — much better
// than raw CSV for messy enterprise spreadsheets.

async function extractXlsx(bytes: Uint8Array): Promise<string> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(bytes, { type: "array", cellStyles: false });
  const parts: string[] = [];

  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws["!ref"]) continue;

    // 1. Expand merged cells — fill each merged region with the top-left value.
    //    Without this, merged cells appear as blanks which confuse the header detector.
    for (const merge of (ws["!merges"] ?? [])) {
      const origin = ws[XLSX.utils.encode_cell({ r: merge.s.r, c: merge.s.c })];
      for (let r = merge.s.r; r <= merge.e.r; r++) {
        for (let c = merge.s.c; c <= merge.e.c; c++) {
          if (r === merge.s.r && c === merge.s.c) continue;
          ws[XLSX.utils.encode_cell({ r, c })] = origin ? { ...origin } : { t: "s", v: "" };
        }
      }
    }

    // 2. Read as 2-D array (row-major, empty cells → "")
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as string[][];
    if (!rows.length) continue;

    // 3. Skip leading empty rows (title banners, logos, blank padding)
    let start = 0;
    while (start < rows.length && rows[start].every(c => String(c).trim() === "")) start++;
    const live = rows.slice(start);
    if (!live.length) continue;

    // 4. Detect the header row: first row where ≥60% of non-empty cells are strings
    //    (i.e. labels, not numbers). Fall back to row 0 if heuristic fails.
    let headerIdx = 0;
    for (let i = 0; i < Math.min(live.length, 6); i++) {
      const nonEmpty = live[i].filter(c => String(c).trim() !== "");
      const strings  = nonEmpty.filter(c => isNaN(Number(c)));
      if (nonEmpty.length > 0 && strings.length / nonEmpty.length >= 0.6) {
        headerIdx = i;
        break;
      }
    }

    // 5. Build normalised column headers (de-dup blank cols)
    const rawHeaders = live[headerIdx];
    const colCount   = Math.max(...live.map(r => r.length));
    const headers    = Array.from({ length: colCount }, (_, i) => {
      const h = String(rawHeaders[i] ?? "").trim();
      return h || `Col${i + 1}`;
    });

    // 6. Emit body rows — skip blank rows, include from row after header
    const bodyRows = live.slice(headerIdx + 1).filter(
      row => row.some(c => String(c).trim() !== "")
    );

    // 7. Render as markdown table (SpreadsheetLLM style)
    const sep  = "|" + headers.map(() => "---").join("|") + "|";
    const head = "| " + headers.join(" | ") + " |";
    const body = bodyRows.map(row =>
      "| " + Array.from({ length: colCount }, (_, i) =>
        String(row[i] ?? "").trim().replace(/\|/g, "\\|")
      ).join(" | ") + " |"
    );

    const summary = `${bodyRows.length} rows × ${colCount} cols`;
    parts.push(`## Sheet: ${name} (${summary})\n\n${[head, sep, ...body].join("\n")}`);
  }

  return parts.join("\n\n");
}

// ── DOCX via mammoth ──────────────────────────────────────────────────────────
// extractRawText gives clean prose with headings and lists, no XML noise.

async function extractDocx(bytes: Uint8Array): Promise<string> {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return value;
}

// ── PDF via @llamaindex/liteparse ─────────────────────────────────────────────
// Preserves spatial layout as ASCII — headings, columns, tables all readable.
// Falls back to rough string extraction if liteparse is unavailable.

async function extractPdf(bytes: Uint8Array): Promise<string> {
  try {
    const { LiteParse } = await import("@llamaindex/liteparse");
    const parser = new LiteParse({ ocrEnabled: false });

    // liteparse accepts Buffer / Uint8Array directly; quiet=true suppresses stderr progress logs
    const result = await parser.parse(Buffer.from(bytes), true);

    // Normalise result shape — API may return .text or .pages[].text
    if (typeof result.text === "string" && result.text.trim()) {
      return result.text;
    }
    if (Array.isArray(result.pages)) {
      return result.pages.map((p: any) => p.text ?? "").join("\n\n");
    }
    return String(result);
  } catch {
    // Graceful fallback: extract visible ASCII strings from PDF binary
    // This handles scanned PDFs or environments where liteparse can't load
    const raw = new TextDecoder("latin1", { fatal: false }).decode(bytes);
    const strings = [...raw.matchAll(/\(([^)]{4,200})\)/g)]
      .map(m => m[1])
      .filter(s => /[a-zA-Z]{3}/.test(s));
    return strings.join(" ").replace(/\s{2,}/g, " ").trim().slice(0, 200_000);
  }
}

// ── Raw sheet export (for LLM normalization) ─────────────────────────────────

export interface RawSheet {
  name:   string;
  rows:   string[][];   // 2-D array after merge expansion, before heuristics
  merges: number;       // count of merged regions
}

/**
 * Return raw 2-D sheet data (merges expanded) without any heuristic normalization.
 * Used by the /s3/normalize LLM endpoint which applies its own analysis.
 */
export async function extractXlsxSheets(bytes: Uint8Array): Promise<RawSheet[]> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(bytes, { type: "array", cellStyles: false });
  const sheets: RawSheet[] = [];

  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws["!ref"]) continue;

    const mergeCount = (ws["!merges"] ?? []).length;

    // Expand merged cells (same as extractXlsx)
    for (const merge of (ws["!merges"] ?? [])) {
      const origin = ws[XLSX.utils.encode_cell({ r: merge.s.r, c: merge.s.c })];
      for (let r = merge.s.r; r <= merge.e.r; r++) {
        for (let c = merge.s.c; c <= merge.e.c; c++) {
          if (r === merge.s.r && c === merge.s.c) continue;
          ws[XLSX.utils.encode_cell({ r, c })] = origin ? { ...origin } : { t: "s", v: "" };
        }
      }
    }

    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as string[][];
    sheets.push({ name, rows, merges: mergeCount });
  }

  return sheets;
}

/**
 * Render a raw sheet into a markdown table given explicit header/data boundaries
 * identified by the LLM normalizer.
 */
export function renderSheetMarkdown(
  sheet: RawSheet,
  headerRow: number,
  dataStartRow: number,
  colIndices?: number[],
): string {
  const { name, rows } = sheet;
  if (!rows.length) return `## Sheet: ${name}\n\n_(empty)_`;

  const hdr  = rows[headerRow] ?? rows[0];
  const cols = colIndices ?? hdr.map((_, i) => i);
  const headers = cols.map(i => String(hdr[i] ?? `Col${i + 1}`).trim() || `Col${i + 1}`);

  const body = rows
    .slice(dataStartRow)
    .filter(row => row.some(c => String(c).trim() !== ""))
    .map(row =>
      "| " + cols.map(i => String(row[i] ?? "").trim().replace(/\|/g, "\\|")).join(" | ") + " |"
    );

  const sep  = "|" + headers.map(() => "---").join("|") + "|";
  const head = "| " + headers.join(" | ") + " |";

  return `## Sheet: ${name} (${body.length} rows × ${cols.length} cols)\n\n${[head, sep, ...body].join("\n")}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract plain text from any supported document format.
 *
 * @param bytes       Raw file bytes
 * @param filename    Original filename (used for extension detection)
 * @param contentType Optional MIME type (for plain-text detection)
 * @returns           Extracted text, or empty string if unsupported
 */
export async function extractText(
  bytes: Uint8Array,
  filename: string,
  contentType = "",
): Promise<string> {
  // Plain text — just decode
  if (isPlainText(filename, contentType)) {
    return new TextDecoder().decode(bytes);
  }

  const ext = extOf(filename);

  if (ext === ".xlsx" || ext === ".xls") return extractXlsx(bytes);
  if (ext === ".docx" || ext === ".doc") return extractDocx(bytes);
  if (ext === ".pdf")                    return extractPdf(bytes);

  // PPTX / other Office formats — rough XML text extraction
  if (ext === ".pptx" || ext === ".ppt") {
    const raw  = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const text = raw.replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim();
    return text.slice(0, 200_000);
  }

  return ""; // unsupported — skip
}

/** All extensions the extractor can handle */
export const EXTRACTABLE_EXTENSIONS = new Set([
  ...PLAIN_TEXT_EXTS,
  ".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt",
]);

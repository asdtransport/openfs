/**
 * Smart text chunker with semantic boundary detection.
 * Ports and improves on the Python indexer's chunk.py.
 * Respects markdown structure: splits on headings first, then paragraphs, then sentences.
 */

import type { Chunk } from "./types.js";

export interface ChunkOptions {
  chunkSize?: number;   // chars, default 1200
  overlap?: number;     // chars, default 200
}

/**
 * Split a document into overlapping chunks that respect markdown structure.
 * Priority order for split points: H2/H3 heading > blank line > sentence > word
 */
export function chunkDocument(
  source: string,
  title: string,
  content: string,
  opts: ChunkOptions = {},
): Chunk[] {
  const chunkSize = opts.chunkSize ?? 1200;
  const overlap = opts.overlap ?? 200;

  const raw = splitText(content, chunkSize, overlap);
  const slugSource = source.replace(/[^a-z0-9]/gi, "-").toLowerCase();

  return raw.map((text, i) => ({
    id: `${slugSource}__chunk_${i}`,
    source,
    title,
    content: text,
    chunkIndex: i,
    totalChunks: raw.length,
  }));
}

function splitText(text: string, chunkSize: number, overlap: number): string[] {
  if (text.length <= chunkSize) return [text.trim()].filter(Boolean);

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start + chunkSize;
    if (end >= text.length) {
      chunks.push(text.slice(start).trim());
      break;
    }

    // Find best split point within [start + chunkSize/2, end + overlap]
    const searchStart = start + Math.floor(chunkSize / 2);
    const searchEnd = Math.min(end + overlap, text.length);
    const window = text.slice(searchStart, searchEnd);

    let splitOffset = findBestSplit(window);
    end = searchStart + splitOffset;

    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);

    // Next chunk starts at end minus overlap
    start = Math.max(start + 1, end - overlap);
  }

  return chunks.filter(c => c.length > 50); // drop tiny tail fragments
}

/**
 * Find the best character offset to split at within a window.
 * Priority: H2/H3 heading > double newline > period+space > space
 */
function findBestSplit(window: string): number {
  // Markdown heading (H2/H3)
  const headingMatch = window.match(/\n#{2,3} /);
  if (headingMatch?.index != null) return headingMatch.index + 1;

  // Double newline (paragraph boundary)
  const paraIdx = window.lastIndexOf("\n\n");
  if (paraIdx > 0) return paraIdx + 2;

  // Single newline
  const nlIdx = window.lastIndexOf("\n");
  if (nlIdx > 0) return nlIdx + 1;

  // Sentence boundary
  const sentIdx = window.lastIndexOf(". ");
  if (sentIdx > 0) return sentIdx + 2;

  // Word boundary
  const wordIdx = window.lastIndexOf(" ");
  if (wordIdx > 0) return wordIdx + 1;

  return window.length;
}

/**
 * Strip HTML tags from fetched web content.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, " ")
    .trim();
}

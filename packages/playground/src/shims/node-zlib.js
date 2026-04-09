// Comprehensive shim for node:zlib — just-bash's browser bundle imports
// various zlib functions but never actually uses gzip in-browser for OpenFS.
const noop = (buf) => buf;
const noopCb = (buf, cb) => { if (cb) cb(null, buf); return buf; };

export const gunzipSync = noop;
export const gzipSync = noop;
export const deflateSync = noop;
export const inflateSync = noop;
export const deflateRawSync = noop;
export const inflateRawSync = noop;
export const unzipSync = noop;
export const brotliCompressSync = noop;
export const brotliDecompressSync = noop;

export const gunzip = noopCb;
export const gzip = noopCb;
export const deflate = noopCb;
export const inflate = noopCb;
export const deflateRaw = noopCb;
export const inflateRaw = noopCb;
export const unzip = noopCb;
export const brotliCompress = noopCb;
export const brotliDecompress = noopCb;

export function createGunzip() { return { on() {}, write() {}, end() {} }; }
export function createGzip() { return { on() {}, write() {}, end() {} }; }
export function createDeflate() { return { on() {}, write() {}, end() {} }; }
export function createInflate() { return { on() {}, write() {}, end() {} }; }
export function createDeflateRaw() { return { on() {}, write() {}, end() {} }; }
export function createInflateRaw() { return { on() {}, write() {}, end() {} }; }
export function createUnzip() { return { on() {}, write() {}, end() {} }; }
export function createBrotliCompress() { return { on() {}, write() {}, end() {} }; }
export function createBrotliDecompress() { return { on() {}, write() {}, end() {} }; }

export const constants = {
  Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3,
  Z_FINISH: 4, Z_BLOCK: 5, Z_TREES: 6, Z_OK: 0, Z_STREAM_END: 1,
  Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3,
  Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6,
  Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9,
  Z_DEFAULT_COMPRESSION: -1, Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3,
  Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0, Z_BINARY: 0, Z_TEXT: 1, Z_ASCII: 1,
  Z_UNKNOWN: 2, Z_DEFLATED: 8, Z_MIN_WINDOWBITS: 8, Z_MAX_WINDOWBITS: 15,
  Z_DEFAULT_WINDOWBITS: 15, Z_MIN_CHUNK: 64, Z_MAX_CHUNK: Infinity,
  Z_DEFAULT_CHUNK: 16384, Z_MIN_MEMLEVEL: 1, Z_MAX_MEMLEVEL: 9,
  Z_DEFAULT_MEMLEVEL: 8, Z_MIN_LEVEL: -1, Z_MAX_LEVEL: 9,
  BROTLI_OPERATION_PROCESS: 0, BROTLI_OPERATION_FLUSH: 1,
  BROTLI_OPERATION_FINISH: 2, BROTLI_OPERATION_EMIT_METADATA: 3,
  BROTLI_MODE_GENERIC: 0, BROTLI_MODE_TEXT: 1, BROTLI_MODE_FONT: 2,
  BROTLI_DEFAULT_QUALITY: 11, BROTLI_MIN_QUALITY: 0, BROTLI_MAX_QUALITY: 11,
  BROTLI_DEFAULT_WINDOW: 22, BROTLI_MIN_WINDOW_BITS: 10, BROTLI_MAX_WINDOW_BITS: 24,
  BROTLI_MIN_INPUT_BLOCK_BITS: 16, BROTLI_MAX_INPUT_BLOCK_BITS: 24,
};

export default {
  gunzipSync, gzipSync, deflateSync, inflateSync, deflateRawSync, inflateRawSync,
  unzipSync, brotliCompressSync, brotliDecompressSync,
  gunzip, gzip, deflate, inflate, deflateRaw, inflateRaw, unzip,
  brotliCompress, brotliDecompress,
  createGunzip, createGzip, createDeflate, createInflate,
  createDeflateRaw, createInflateRaw, createUnzip,
  createBrotliCompress, createBrotliDecompress,
  constants,
};

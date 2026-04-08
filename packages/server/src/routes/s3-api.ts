/**
 * S3 API proxy routes
 *
 * Proxies requests from /api/s3/* to the @openfs/adapter-s3-api FastAPI service.
 * This allows the playground to access the full S3 management API through
 * the main OpenFS server without CORS issues.
 */

import { Hono } from "hono";

const MINIO_API_URL = process.env.MINIO_API_URL || "http://localhost:8080";

export const s3ApiRoutes = new Hono();

// Published S3 endpoint config — WASM page calls this to auto-discover connection
s3ApiRoutes.get("/config", async (c) => {
  const bucket = (globalThis as any).Bun?.env?.S3_BUCKET ?? "openfs-playground";
  let status = "unknown";
  try {
    const res = await fetch(`${MINIO_API_URL}/health`);
    status = res.ok ? "ready" : "degraded";
  } catch {
    status = "unavailable";
  }
  return c.json({
    endpoint: "/api/s3",
    bucket,
    token: "demo-token",
    status,
    description: "OpenFS MinIO (local)",
  });
});

// Health check shortcut
s3ApiRoutes.get("/health", async (c) => {
  try {
    const res = await fetch(`${MINIO_API_URL}/health`);
    const data = await res.json();
    return c.json({ ...data, proxy: true });
  } catch (err: any) {
    return c.json({ status: "unavailable", error: err.message, proxy: true }, 503);
  }
});

// Proxy all requests to the adapter-s3-api service
s3ApiRoutes.all("/*", async (c) => {
  const url = new URL(c.req.url);
  const path = url.pathname.replace(/^\/api\/s3/, "");
  const targetUrl = `${MINIO_API_URL}/api/v1${path}${url.search}`;

  try {
    const headers = new Headers();
    // Forward relevant headers
    for (const [key, value] of Object.entries(c.req.header())) {
      if (
        key.toLowerCase() !== "host" &&
        key.toLowerCase() !== "content-length" &&
        value
      ) {
        headers.set(key, value);
      }
    }
    // Pass through demo auth token for S3 API
    if (!headers.has("authorization")) {
      headers.set("Authorization", "Bearer demo-token");
    }

    const fetchOpts: RequestInit = {
      method: c.req.method,
      headers,
    };

    // Forward body for non-GET requests
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      fetchOpts.body = await c.req.raw.text();
    }

    const upstream = await fetch(targetUrl, fetchOpts);

    // Stream the response back
    const responseHeaders = new Headers();
    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "transfer-encoding") {
        responseHeaders.set(key, value);
      }
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (err: any) {
    return c.json(
      {
        error: "S3 API unavailable",
        detail: err.message || String(err),
        target: targetUrl,
      },
      503,
    );
  }
});


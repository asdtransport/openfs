/**
 * Auth middleware stub
 * Wire to your auth provider for RBAC group extraction.
 */

import type { Context, Next } from "hono";

export async function authMiddleware(c: Context, next: Next) {
  // Extract user groups from auth token
  // const token = c.req.header("Authorization")?.replace("Bearer ", "");
  // const groups = await verifyAndExtractGroups(token);
  // c.set("userGroups", groups);

  c.set("userGroups", ["public"]);
  await next();
}

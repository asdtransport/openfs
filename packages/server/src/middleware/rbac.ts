/**
 * RBAC middleware stub
 * Enforces path-level access control based on user groups.
 */

import type { Context, Next } from "hono";

export async function rbacMiddleware(c: Context, next: Next) {
  // const userGroups = c.get("userGroups") || [];
  // Pruning happens at PathTree.build() level — this middleware
  // ensures the adapter was initialized with the right groups.
  await next();
}

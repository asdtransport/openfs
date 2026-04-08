# OpenFS — Security Review

## Authentication & Authorization

### Current State

| Component | Auth Mechanism | Status |
|-----------|---------------|--------|
| Hono server (`packages/server`) | `authMiddleware` — hardcoded `["public"]` groups | **Stub only** |
| RBAC middleware | `rbacMiddleware` — pass-through, relies on PathTree pruning | **Stub only** |
| Sync server (`agent-wiki-mw`) | PBKDF2 (100K iterations, SHA-256) + JWT (HS256, 7-day expiry) | **Implemented** |
| S3 API proxy | Hardcoded `Bearer demo-token` header | **Placeholder** |
| Telegram bot | `ALLOWED_CHAT_IDS` whitelist (optional) | **Basic** |
| MediaWiki | Username/password login with CSRF tokens | **Standard MW auth** |

### Strengths

- **PBKDF2 with 100K iterations** — meets OWASP minimum recommendation
- **Constant-time password comparison** — prevents timing attacks (`diff |=` pattern)
- **JWT with expiration** — 7-day tokens prevent indefinite session reuse
- **Default admin seeding** with a warning to change the password
- **PathTree RBAC design** — access control pruned at tree build time, not at query time (zero runtime cost)

### Risks

1. **Hardcoded credentials in source**: `MW_PASS = "Yugioh4444!"`, MinIO defaults `minioadmin/minioadmin`, `Bearer demo-token`
2. **JWT secret in env var** with weak default: `"openfs-default-secret-change-me"`
3. **No rate limiting** on any endpoint
4. **No input sanitization** on shell commands passed to `just-bash` — relies on `just-bash` being sandboxed
5. **CORS wide open** — Hono server allows all origins (acceptable for dev, not prod)
6. **S3 proxy forwards all requests** — no authorization check on the proxy layer
7. **Anthropic/OpenAI API keys in `.env`** — standard practice but no rotation mechanism

### Recommendations

1. Implement the auth middleware stubs before production deployment
2. Rotate all default credentials; use secrets management
3. Add rate limiting (especially on LLM-calling endpoints)
4. Add CORS allowlist for production
5. Validate/sanitize shell command input before passing to `just-bash`
6. Add authorization to the S3 proxy layer

## Data Security

- **SQLite WAL mode** — data integrity during concurrent access
- **In-memory option** — `:memory:` DB avoids disk persistence for ephemeral use
- **WASM isolation** — browser runtime has no access to real filesystem
- **No PII detection** — ingested documents are stored as-is with no redaction
- **Synthesis map on disk** — `.synthesis-map.json` persists via volume mount (ensure proper permissions)

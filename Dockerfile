FROM oven/bun:1.3-alpine

WORKDIR /app

# System tools: sqlite3 CLI, bash
RUN apk add --no-cache sqlite bash

# Install pnpm
RUN bun install -g pnpm

# Copy workspace config first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/core/package.json packages/core/
COPY packages/adapter-sqlite/package.json packages/adapter-sqlite/
COPY packages/adapter-chroma/package.json packages/adapter-chroma/
COPY packages/adapter-mysql/package.json packages/adapter-mysql/
COPY packages/adapter-postgres/package.json packages/adapter-postgres/
COPY packages/adapter-s3/package.json packages/adapter-s3/
COPY packages/adapter-turso/package.json packages/adapter-turso/
COPY packages/grep-optimizer/package.json packages/grep-optimizer/
COPY packages/server/package.json packages/server/
COPY packages/playground/package.json packages/playground/

# Install dependencies
RUN pnpm install --frozen-lockfile || pnpm install

# Copy all source
COPY . .

# Default: run tests
CMD ["bun", "test", "tests/integration.test.ts"]

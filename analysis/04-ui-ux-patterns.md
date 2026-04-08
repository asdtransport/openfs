# OpenFS — UI/UX Patterns

## Primary Interface: Astro Playground Terminal

The playground (`packages/playground`) is a browser-based interactive terminal built with **Astro** + **xterm.js**. It's the main user-facing interface.

### Layout

- **Sidebar navigation** — fixed left panel with links to Terminal, Wiki, WASM, and external Telegram bot
- **Top bar** — mode toggle (WASM/Server), adapter toggle (SQLite/Chroma/S3), connection status pill
- **Main content** — full-height terminal emulator with macOS-style chrome (traffic light dots)
- **Quick-action chips** — clickable command shortcuts above the terminal

### UX Patterns

| Pattern | Implementation |
|---------|---------------|
| **Mode switching** | WASM (client-side) vs Server (remote API) toggle — changes available commands and chips |
| **Adapter switching** | SQLite/Chroma/S3 buttons with color-coded prompts (purple/orange/green) |
| **Command chips** | Pre-built clickable commands (`ls /docs`, `grep access_token`, `help`) reduce friction |
| **Color-coded output** | ANSI escape sequences for errors (red), success (green), metadata (dim gray), accents (purple) |
| **Connection status** | Live green dot / red error dot with text status in top bar |
| **Command history** | ↑/↓ arrow keys navigate history (standard terminal UX) |
| **Paste support** | Custom paste handler strips newlines; Ctrl+V / Cmd+V pass-through |
| **Ctrl+C / Ctrl+L** | Standard terminal shortcuts for cancel and clear screen |
| **Table formatting** | `writeTable()` renders aligned ASCII tables for structured data (buckets, objects) |
| **JSON pretty-print** | `writeJson()` for stats and API responses |
| **Loading states** | Dim text indicators ("Fetching...", "Searching...") before async results |
| **Error handling** | Red `Error: <message>` with contextual suggestions (`Try: help`) |

### Visual Design

- **Dark terminal theme** — `#12121a` background, warm cursor (`#b8862e`), purple accents
- **Font stack** — JetBrains Mono → SF Mono → Fira Code → Cascadia Code (developer-focused)
- **macOS window chrome** — red/yellow/green dots on the terminal frame
- **Responsive** — `FitAddon` auto-sizes terminal to container; resize listener attached
- **CSS variables** — `--font`, `--mono`, `--surface`, `--border`, `--navy` for consistent theming
- **Minimal border-radius** — 5px on buttons/chips, 10px on terminal wrapper

### Dual-Mode Architecture

**WASM Mode** (default):
- All computation runs in-browser via sql.js WASM
- Grep optimizer works client-side (FTS5 → just-bash)
- Adapter-specific commands: `sqlite help`, `chroma help`, `s3 help`
- No server dependency for basic operations

**Server Mode**:
- Connects to `agent-wiki-mw` sync server on port 4322
- Wiki operations: `pages`, `pull`, `push`, `ask`, `agent`
- Knowledge graph: `semantic`, `embed wiki`, `expand <topic>`
- Quality checks: `lint`, `log`
- Different chip set appears based on mode

### Welcome Screen

ASCII art OpenFS logo in purple, followed by dim instruction text. Sets professional but approachable tone.

## Secondary Pages

| Page | Purpose |
|------|---------|
| `wiki.astro` | MediaWiki management interface |
| `wasm.astro` | Standalone WASM demo page |

## Telegram Bot UX

- **Conversational** — any text message becomes a wiki query
- **Command menu** — `/ask`, `/grep`, `/cat`, `/pages`, `/recent`, `/ingest`, `/sync`, `/status`
- **Progress indicators** — "🤔 Thinking..." message edited in-place when answer arrives
- **URL ingestion** — paste a URL to auto-fetch, extract, and synthesize wiki pages
- **Citation links** — answers include MediaWiki links to source pages
- **Auth guard** — optional `ALLOWED_CHAT_IDS` whitelist

## UX Strengths

1. **Zero-learning-curve** — UNIX commands are universally known by the target audience
2. **Progressive disclosure** — `help` command reveals full capability; chips show common actions
3. **Multi-modal access** — same knowledge base accessible via browser, API, Telegram, CLI
4. **Instant feedback** — WASM mode has no network latency for basic operations
5. **Graceful degradation** — connection status pill shows when server is offline; WASM still works

## UX Improvement Opportunities

1. **No autocomplete/tab completion** — would significantly improve terminal UX
2. **No syntax highlighting** in file content output
3. **No pagination** for large outputs (long `cat` or search results)
4. **No persistent state** in WASM mode — refreshing the page loses ingested files
5. **Mobile responsiveness** — terminal UI is desktop-optimized

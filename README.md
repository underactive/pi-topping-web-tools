# @underactive/pi-topping-web-tools

Web tools bundle for [pi](https://github.com/earendil-works/pi): keyless URL-to-markdown fetching, PDF text extraction, and headless Playwright browser automation, sharing one preapproved-host allowlist and permission model.

## Install

```bash
pi install npm:@underactive/pi-topping-web-tools
```

The `web_browser` tool additionally requires Playwright's Chromium (~150MB):

```bash
npx playwright install chromium
```

## Why this extension

Web work has two distinct needs: clean context from public sources and browser-level verification of the live experience. This bundle gives pi both, so an agent can move from a documentation question to an interactive check without stitching together unrelated extensions. Public-page retrieval is keyless, while browser automation remains available for the cases where a static fetch cannot answer the question.

- **Keep research focused.** `fetch_markdown` converts public documentation, READMEs, and articles into Markdown, extracting the primary article instead of a page's surrounding navigation. Its cache makes iterative questions against the same source faster.
- **Reach PDF-only sources.** `pdf_extract` reads the text layer of specifications, datasheets, and papers that markdown fetchers treat as undisplayable binary content, and that pi's `read` tool cannot parse.
- **Validate the rendered product.** `web_browser` runs a fresh headless Chromium context for client-rendered pages, local development servers, and user journeys that static HTML cannot represent. It can inspect the accessibility tree, interact with controls, and surface console and failed-network diagnostics.
- **Use the appropriate tool, not the heavier tool by default.** Fetch static public material first; move to browser automation when JavaScript, visual state, or user input is part of the question.
- **Keep control over access.** The tools share a host allowlist and confirmation workflow; fetched page text is explicitly marked as untrusted, and browser sessions do not reuse the system browser profile.

## Examples

Give pi a task like the following; the extension supplies the web capabilities needed to complete it.

### Research a dependency before changing code

> Read `https://react.dev/reference/react/useEffect`. Summarize the cleanup behavior, identify the parts relevant to subscriptions, and cite the sections I should review before changing this component.

`fetch_markdown` returns the page as focused Markdown, making it useful for documentation research without spending context on site chrome. Repeated follow-up questions can reuse the cached response.

### Verify a local user journey

> Open `http://localhost:3000`, set a 390×844 viewport, add an item to the cart, and report any failed network requests or console errors. Save a screenshot of the final state.

`web_browser` can drive the local application as a user would, then collect the diagnostics that explain a failed interaction rather than only reporting that it failed.

### Investigate a JavaScript-heavy page

> Review the migration guide at `https://example.com/migration`. If the important content is not present in the static page, inspect the live page in the browser and return the breaking changes that affect this project.

Start with `fetch_markdown` for efficient static content; use `web_browser` when the page depends on client-side rendering or requires interaction. The two tools let the agent choose the lowest-cost path that still produces reliable evidence.

## Tools

| Tool | Description |
|------|-------------|
| `fetch_markdown` | Fetch a public URL and return its content as markdown (cached, keyless) |
| `pdf_extract` | Extract the text layer from a remote or local PDF, with page markers |
| `web_browser` | Headless Chromium automation — navigate, click, type, screenshot, evaluate, logs, cookies |

## `fetch_markdown`

Complements pi's built-in search-backed `web_fetch` with a lightweight, keyless fetch path for public documentation, READMEs, and articles:

- **Native fetch** — no API keys, no provider routing
- **HTML → markdown** — [turndown](https://github.com/mixmark-io/turndown) conversion for readable agent context
- **Readability extraction** — [@mozilla/readability](https://github.com/mozilla/readability) (via [linkedom](https://github.com/WebReflection/linkedom)) strips nav/footer/sidebar boilerplate from article pages by default; pass `raw: true` for the full page. Falls back to full-page conversion when a page doesn't look like an article
- **15-minute LRU cache with revalidation** — faster repeat lookups; expired entries are revalidated with `If-None-Match`/`If-Modified-Since` when the server sent `ETag`/`Last-Modified`, so unchanged pages cost a 304 instead of a full download
- **Strict redirect handling** — redirects that change host, scheme, or port, or that leave a preapproved path, return the redirect URL instead of being followed; call again to follow (`www.` prefixes are treated as the same host)
- **Host confirmation** — prompts for non-preapproved hosts (session or durable allow/deny; see Saved permissions)

Usage notes:

- HTTP URLs are upgraded to HTTPS automatically
- Content is returned in 100K-character windows; truncated responses report the `offset` to pass for the next window
- For GitHub repo content, prefer `web_fetch` or the `gh` CLI
- JS-rendered SPAs may return empty markdown (static HTML only)
- Authenticated or private pages (Google Docs, Confluence, Jira) are not supported

Command: `/clear-fetch-markdown-cache` — clear the in-memory URL cache.

## `pdf_extract`

PDFs are otherwise unreachable: `fetch_markdown` and pi's `web_fetch` classify `application/pdf` as binary, and the `read` tool cannot parse it. This tool extracts the text layer via [unpdf](https://github.com/unjs/unpdf) (a serverless build of Mozilla's PDF.js, keyless and with no native dependencies).

- **Remote or local** — pass `url` for a remote PDF or `path` for an absolute or relative path, or a `file://` URL; provide exactly one
- **Page markers** — output is delimited with `--- Page N ---` so pages can be cited
- **Page selection** — `pages` accepts `"3"`, `"1-5"`, or `"1,4,7-9"`; defaults to every page
- **15-minute LRU cache** — the whole parse is cached, so a later `pages` or `offset` call reuses it; local files are re-read when their modification time changes
- **Host and file confirmation** — remote URLs use the shared allowlist; local files inside the working directory are read without prompting, anything outside prompts (session-scoped allow/deny for local files; session or durable for remote URLs)

Usage notes:

- Content is returned in 100K-character windows; truncated responses report the `offset` to pass for the next window
- Scanned or image-only PDFs have no text layer and report that explicitly — there is no OCR
- Limits: 25MB download, 2000 pages, and a 30s extraction timeout

Command: `/clear-pdf-extract-cache` — clear the in-memory PDF text cache.

## `web_browser`

Single tool with an `action` parameter:

| Action | Parameters | Description |
|--------|------------|-------------|
| `navigate` | `url` | Open a URL or `file://` path (HTTP upgraded to HTTPS except localhost/.local/private IPs) |
| `screenshot` | `fullPage?`, `selector?`, `toFile?` | Capture PNG screenshot (base64 image, or temp file path when `toFile=true`) |
| `click` | `selector` | Click a CSS selector |
| `type` | `selector`, `text`, `mode?` | Fill (`mode=fill`, default) or key-by-key type (`mode=press`) into a selector |
| `hover` | `selector` | Hover over a CSS selector (tooltips, hover-menus) |
| `press` | `key` | Press a keyboard key globally (Enter, Escape, Tab, etc.) |
| `select_option` | `selector`, `values` | Select option(s) in a `<select>` dropdown (comma-separated values) |
| `set_viewport` | `width`, `height` | Resize the browser viewport (persists until changed or browser closes) |
| `evaluate` | `script` | Run JavaScript in the page context (re-checks permission for the current page URL) |
| `get_content` | — | Return raw page HTML |
| `get_text` | `selector?` | Return visible text (layout-aware innerText; default selector `body`) |
| `get_markdown` | — | Return page content as markdown (headings, lists, links) |
| `wait_for` | `selector?`, `state?`, `networkidle?` | Wait for selector state and/or network idle |
| `get_accessibility_snapshot` | `selector?` | Return ARIA accessibility tree (YAML) |
| `get_console_logs` | — | Drain captured console/page errors |
| `get_network_logs` | — | Drain captured failed requests and 4xx/5xx responses |
| `get_cookies` | — | Return cookie metadata as JSON (name, domain, path, flags; values are redacted) |
| `set_cookies` | `cookies` | Set cookies (each needs `url` or `domain`+`path`) |
| `go_back` / `go_forward` / `reload` | — | Browser history navigation / reload |
| `scroll` | `selector?`, `frame?`, `deltaX?`, `deltaY?` | Scroll an element into view (`selector`) or scroll by pixel deltas (default `deltaY` = viewport height) |
| `drag` | `selector`, `targetSelector`, `frame?` | Drag-and-drop from `selector` to `targetSelector` |
| `upload_file` | `selector`, `files`, `frame?` | Set files on an `<input type=file>` (absolute or relative paths) |
| `set_dialog_behavior` | `dialogAction?`, `promptText?` | Configure how future JS dialogs (alert/confirm/prompt) are resolved for the rest of the session (default: dismiss) |
| `get_dialog_logs` | — | Drain captured dialogs (type, message, default value, resolution) |
| `list_tabs` | — | List open tabs (index, URL, title, active) |
| `switch_tab` | `index` | Switch the active tab (from `list_tabs`) |
| `close` | — | Close the browser |

Optional `timeout` (ms, default 30000) applies to navigation and to selector-based actions (click, type, hover, select_option, screenshot, get_text, get_markdown, wait_for, get_accessibility_snapshot, scroll, drag, upload_file). Other actions use Playwright defaults.

Selectors are CSS selectors, or Playwright's `role=` and `text=` selector engines (e.g. `role=button[name='Submit']`, `text=Sign in`). Pass `frame` (a CSS selector for the containing `<iframe>`) to scope click/type/hover/select_option/screenshot/get_text/wait_for/get_accessibility_snapshot/scroll/upload_file/drag into that frame.

Opening a link with `target=_blank` or `window.open` creates a popup that automatically becomes the active tab — subsequent actions target it until you `switch_tab` back. Use `list_tabs` to see all open tabs.

JS dialogs (`alert`/`confirm`/`prompt`) are dismissed by default so they never block automation; call `set_dialog_behavior` before the action that triggers one if you need `accept` instead (and, for `prompt`, a `promptText` value).

Commands:

- `/browser` — show open/closed status, current URL, title, tab count, console/network/dialog counts, session-approved host count, and saved durable host count
- `/browser-close` — force close the browser
- `/browser-screenshot` — save a full-page screenshot to a temp PNG file

Status line: a footer segment (`browser: example.com`) appears while the browser is open.

## Saved permissions

When the host confirmation prompt offers a durable option ("Allow for 1 day", "Allow for 1 week", "Allow for 30 days"), the grant is persisted to `~/.pi/agent/web-permissions.json` (mode `0600`) and applies across all sessions and projects.

- **Per-tool scope.** A `fetch_markdown` grant does not authorize `web_browser`, which executes JavaScript and drives interaction. Each tool scopes its grants independently.
- **Exact origin.** Grants match `scheme://host[:port]` exactly — no subdomain wildcards, no cross-port or cross-scheme reuse.
- **Max 30 days.** All grants expire; there is no indefinite option. Expired entries are pruned automatically.
- **Local files excluded.** `file://` prompts never offer durable options; local-file access needs a path-scope design that is out of scope here.
- **Headless behavior.** Active durable grants apply when there is no interactive UI (e.g. RPC or print mode). Without a grant, non-preapproved hosts remain blocked.

Commands:

- `/web-permissions` — list and revoke saved grants. Bundled preapproved hosts are not listed (they are code, not user grants).

## Security model (shared)

- **Preapproved hosts**: common documentation and dev sites are allowed without prompting. The allowlist lives in `src/permissions.ts` and is shared by both tools.
- **User confirmation**: other hosts prompt Allow once / Allow for this session / Allow for 1 day / Allow for 1 week / Allow for 30 days / Deny.
- **URL validation**: all tools reject embedded credentials and overlong URLs. `fetch_markdown` and `pdf_extract` additionally reject loopback, private, and link-local hosts and any non-HTTP(S) scheme on a `url`. `web_browser` accepts `localhost`, private IPs, and `file://` paths so it can drive local dev servers and local HTML — each still prompts for confirmation unless session-approved or covered by a saved durable grant.
- **Local file resolution**: `pdf_extract` resolves a `path` through `realpath` before any check, so a symlink pointing outside the working directory is treated as outside and prompts. Directories, FIFOs, and devices are rejected, and the size limit is enforced from `stat` before any bytes are read.
- **Isolated browser context**: each session uses a fresh Chromium context (no shared profile/cookies with your system browser).
- **Untrusted content boundary**: `fetch_markdown` results are wrapped in `<untrusted-content url="…">` tags, and `pdf_extract` results in `<untrusted-content source="…">`, so the model treats fetched page and document text as data, not instructions.
- **PDF resource limits**: extraction is bounded by download size, page count, and a timeout. Because the bundled PDF.js runs on the event loop rather than a worker, the timeout bounds extraction across its await points but cannot interrupt a fully synchronous parse — the size and page caps are the primary defence.

## Limitations

- `web_browser` requires the Chromium download.
- Screenshots consume significant context on vision models — prefer `get_text`, `get_markdown`, or `get_accessibility_snapshot`.
- Network logs capture only failed requests and 4xx/5xx responses (not all traffic).
- `pdf_extract` reads only an existing text layer; scanned documents need OCR, which is out of scope.

### Popups and navigation

Popups inherit the same security model as same-tab link clicks: opening a `target=_blank` link or calling `window.open` is not gated by the host allowlist, since it's JS-initiated navigation rather than a tool-driven `navigate` call. `evaluate` remains gated per active page URL — the permission check follows the active-tab cursor automatically, so switching to a popup and calling `evaluate` re-checks permission for that popup's URL.

## Development

Requires Node >= 22.19 (tests run TypeScript directly via `node --test`).

```bash
npm install
npm run typecheck
npm test          # browser tests require Chromium
```

# Changelog

## [Unreleased]

## [0.2.2] - 2026-09-02

### Added

- `web_browser`: fail-closed browser-context egress enforcement for HTTP(S) requests and WebSocket connections, with live preapproved/session/durable permission checks and blocked-request reporting in network logs. Service workers are disabled so they cannot bypass routing.

### Changed

- `web_browser`: inspects redirect targets before contact, follows approved top-level redirects one gated hop at a time, blocks redirected subresources, closes unapproved popups before activation, and restores the prior page after blocked client-side navigation.
- `web_browser`: retains an Allow once navigation decision as a browser-session grant so the approved document and its later same-origin requests can pass request-level enforcement.

### Fixed

- `web_browser`: treat an empty optional selector as the default `body` selector for `get_text` and `get_accessibility_snapshot`, avoiding invalid empty CSS-selector errors.
- `web_browser`: treats bare and `www.` variants of a remote hostname as equivalent for session and durable egress grants, allowing redirects such as `apple.com` → `www.apple.com` without a second approval while keeping other subdomains gated.

## [0.2.1] - 2026-08-31

### Added

- `web_browser`: publishes browser state through the `pi-topping-web-tools/browser` custom session feed for statusline consumers. Truthy `PI_SUPPRESS_NOTIFICATIONS` values hide the native browser footer without suppressing feed entries.

### Changed

- `fetch_markdown`, `pdf_extract`: send browser-like HTTP headers (Accept, Accept-Language, User-Agent, Sec-Fetch-*, etc.) to reduce blocking by User-Agent-based filters; `PI_FETCH_USER_AGENT` overrides the default User-Agent.

## [0.2.0] - 2026-08-18

### Added

- `fetch_markdown`, `pdf_extract`, `web_browser`: durable host permissions — the confirmation prompt now offers "Allow for 1 day", "Allow for 1 week", and "Allow for 30 days" options for remote (http/https) hosts. Grants are persisted to `~/.pi/agent/web-permissions.json` (per-tool scope, exact origin, max 30 days, `0600` mode) and apply across all sessions and projects. `file://` prompts remain session-only.
- `/web-permissions` command: list and revoke saved durable grants. Bundled preapproved hosts are not listed.
- `web_browser`: `/browser` command now shows the count of saved durable hosts in addition to session-approved hosts.

### Changed

- `fetch_markdown`, `pdf_extract`: consolidated shared fetch plumbing — `combineSignals` extracted to `src/abort-utils.ts` (built on `AbortSignal.timeout`), single-use helpers inlined.

### Fixed

- `fetch_markdown`, `pdf_extract`, `web_browser`: double quotes in URLs/sources interpolated into `<untrusted-content>` attributes are escaped, so a crafted URL cannot break out of the tag.
- `fetch_markdown`, `pdf_extract`: private IPv4-mapped IPv6 addresses (dotted-quad and hex forms) are now detected and rejected as local/private hosts.
- `web_browser`: `upload_file` now prompts for confirmation before reading files outside the working directory.
- Durable permission store: stale locks are verified before takeover, closing a race between concurrent sessions writing `web-permissions.json`.

## [0.1.0] - 2026-08-17

### Added

- Initial bundle: `fetch_markdown` and `web_browser` pi extensions with a shared preapproved-host allowlist, merged from the standalone `pi-fetch-markdown-tool`, `pi-web-browser-tool`, and `pi-web-permissions` packages.
- `web_browser`: `scroll` action (selector-based `scrollIntoView` or pixel-delta mouse wheel).
- `web_browser`: `drag` action for drag-and-drop between two selectors.
- `web_browser`: `upload_file` action to set files on an `<input type=file>`.
- `web_browser`: `set_dialog_behavior` and `get_dialog_logs` actions to configure and inspect handling of JS `alert`/`confirm`/`prompt` dialogs (dismissed by default).
- `web_browser`: `list_tabs` and `switch_tab` actions for multi-tab sessions; popups (`target=_blank`, `window.open`) automatically become the active tab.
- `web_browser`: `frame` parameter on selector-based actions (click, type, hover, select_option, screenshot, get_text, wait_for, get_accessibility_snapshot, scroll, upload_file, drag) to target elements inside an `<iframe>`.
- `web_browser`: selectors now also accept Playwright's `role=` and `text=` selector engines, not just CSS.
- `fetch_markdown`: `offset` parameter to paginate past the 100K-character truncation limit; truncated responses report the offset to continue from.
- `fetch_markdown`: readability article extraction (`@mozilla/readability` + `linkedom`) on HTML pages by default, stripping nav/footer boilerplate; the page title is restored as the leading heading, `raw: true` opts out, and non-article pages fall back to full-page conversion.
- `fetch_markdown`: conditional revalidation of expired cache entries via `If-None-Match`/`If-Modified-Since`; a 304 reuses the cached markdown and refreshes the TTL.
- `pdf_extract`: new tool extracting the text layer from remote (`url`) or local (`path`) PDFs via `unpdf`, which `fetch_markdown` and `web_fetch` treat as undisplayable binary content. Output carries `--- Page N ---` markers, `pages` selects a range (`"3"`, `"1-5"`, `"1,4,7-9"`), `offset` paginates past the 100K-character limit, and results are wrapped in `<untrusted-content>`. Local paths resolve through `realpath` before permission checks so symlinks cannot escape the working directory, and extraction is bounded by 25MB, 2000 pages, and a 30s timeout. Adds the `/clear-pdf-extract-cache` command.

### Changed

- `fetch_markdown`: raised the maximum HTTP body size from 10 MB to 25 MB so very large single-page documents (e.g. the WHATWG HTML spec) can be fetched and paginated with `offset`.
- `fetch_markdown`: renamed the internal `sliceMarkdown` helper to `sliceContent` and the `getWithPermittedRedirects` header parameter to `extraHeaders`, so `pdf_extract` can reuse the same content-windowing and redirect logic.

### Fixed

- `fetch_markdown`: tool errors rendered as `Received NaNMB (undefined undefined)`; error results now fall back to the error text.

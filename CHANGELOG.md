# Changelog

## [Unreleased]

### Changed

- Depend on `@underactive/pi-topping-primitives` `^0.11.0` (was `^0.10.0`). No imports changed; only primitives 0.11.0 glyphs were added, with no visible behavior change.

## [0.3.0] - 2026-10-21

### Changed

- Tested against pi 1.4.0. No break: the extension-facing declaration surface (`ExtensionAPI`, `ToolDefinition`, `ExtensionContext`, `ExtensionUIContext`) is unchanged, pi-ai and pi-tui changes are additive or internal, and the provider-header, summary and classifier changes do not reach these tools. Concurrent extension dialogs no longer replace each other on 1.4.0, so parallel host-permission prompts from several tool calls all settle.
- Bumped the pinned `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` devDependencies from 1.3.0 to 1.4.0.
- Depend on `@underactive/pi-topping-primitives` `^0.10.0` (was `^0.9.0`). Nothing it imports changed in between: 0.10.0 removed only the `pi-topping-compact` entry names from `./contracts`, which it never referenced. Every topping now asks for the same range, so an install of several shares one copy of the library. No visible change.
- Tool-exposure settings are read through the shared `@underactive/pi-topping-primitives` 0.2.0 settings store, and the permission grant store writes through its `atomicWriteFile` (unique temp names, cleaned up on failure). An empty `PI_WEB_TOOLS_SETTINGS_FILE` is now treated as unset instead of as a path. The grant store keeps its own lock file and format.
- `web_browser`: source the session-feed entry type and payload from `@underactive/pi-topping-primitives` 0.1.0; the feed's wire format is unchanged.
- Depend on `@underactive/pi-topping-primitives` `^0.9.0`. The environment-flag helpers (`isTruthyEnvFlag`, `suppressNotifications`) and `combineSignals` now come from its `./env` and `./abort` subpaths. Behaviour is unchanged except that a timeout above 2^31 - 1 ms is clamped to that instead of aborting the request after about a millisecond, and a timeout that `AbortSignal.timeout` rejects no longer leaves a stale entry in the active-fetch set.
- `web_browser`: keep the event loop open while `close()` waits on a stalled cleanup, preventing the process from hanging on shutdown.

## [0.2.9] - 2026-10-16

### Added

- Optional `toolExposure` setting (`direct` default, or `codemode` / `deferred`) in `~/.pi/agent/pi-topping-web-tools/settings.json`. All three tools share the `pi-topping-web-tools` namespace. At each session start, a non-`direct` mode activates the loader it needs with `pi.setActiveTools()`: `codemode` for `codemode`, and `tool_search` (or `codemode` when `tool_search` is not registered) for `deferred`. `defaultTools` needs no `+codemode` / `+tool_search` entry. When `--tools` or `--exclude-tools` leaves the loader out, the extension notifies once instead.
- README settings profiles for default direct tools, codemode-minimal (`inlineBudget: 0`), and deferred + `tool_search`. Clarified that a large `inlineBudget` moves declarations into the `codemode` description instead of shrinking them.

### Changed

- Tested against pi 1.2.0. No break: the 1.2.0 breaking changes (`before_agent_start` for `triggerTurn` runs, busy session during run start, theme schema validation, `pi mcp list --json` shape) touch APIs and resources this package does not use.
- Bumped the pinned `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` devDependencies from 1.1.0 to 1.2.0.
- Tested against pi 1.3.0. No break: the extension-facing declaration surface (`ExtensionAPI`, `ToolDefinition`, `ExtensionContext`, `ExtensionUIContext`) is unchanged, pi-ai only adds optional `ToolCall.argumentsError`, and pi-tui is unchanged. Provider, `/share`, and model-switching changes do not reach these tools.
- Bumped the pinned `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` devDependencies from 1.2.0 to 1.3.0.

### Fixed

- `web_browser`: the `mode`, `state`, `cookies[].sameSite`, and `dialogAction` parameter schemas now pass `as const` arrays to `StringEnum`, so their inferred types are the literal unions instead of `string`. This fixes four `tsc` errors; runtime validation is unchanged.

## [0.2.8] - 2026-10-12

### Added

- Documented that the default `codemode.inlineBudget` (3000 estimated tokens) leaves `web_browser` out of the `codemode.mode: "only"` tool listing when it is loaded with `fetch_markdown`, `pdf_extract`, and the built-in `read`, `bash`, `edit`, and `write`, and the budget that fits them.
- Documented how a codemode script inspects a saved screenshot with `tools.read` and `image()` on pi 1.0.4+, and the fallback on older hosts.

### Changed

- Tested against pi 1.1.0. No break: the 1.0.4 and 1.1.0 extension-facing changes are additive (`ToolLoadout.getPromptGuidelines()`, and `durationMs` and `outputPad` on the tool render context), and codemode now lists each tool's prompt guidelines with its declaration, which is why `web_browser` no longer fits the default `codemode.inlineBudget` in `only` mode.
- Bumped the pinned `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` devDependencies from 1.0.3 to 1.1.0.
- `web_browser`: the codemode screenshot guideline now tells a script to save the screenshot with `toFile=true`, read the file with `tools.read({ path })`, and pass the resulting image block to `image()`. This needs pi 1.0.4+, where `read` returns an image block for image files. A script that calls `web_browser` still receives only text, because the tool declares no output schema.

### Fixed

- `fetch_markdown`, `pdf_extract`, `web_browser`: a forged `</untrusted-content>` closing tag in fetched or page text is now escaped to `<\/untrusted-content` instead of deleted. Deletion could reassemble a real closer from split text such as `</untrusted-</untrusted-contentcontent>`, so hostile text could end the fence early and be read as trusted text. The match is case-insensitive, and the fence-escape tests now assert exactly one closing tag.
- `fetch_markdown`, `pdf_extract`, `web_browser`: an expanded result preview drops terminal control characters from its body before styling, so a page cannot emit an OSC 52 clipboard write or another escape sequence while a result is drawn. `web_browser` also replaces control characters with spaces in a page title and in a tool error message.
- `web_browser`: the `navigate` result now puts the status line before an `<untrusted-content>` fence that holds only the page title, and the `list_tabs` result is fenced the same way, because a tab title comes from the page. Both results held page-controlled text outside a fence before.

## [0.2.7] - 2026-10-05

### Changed

- Tested against pi 1.0.3. No break: the extension-facing declaration surface is unchanged apart from additive `registerToolRenderer`/`ToolRenderers`, pi-ai adds `samplingParamsByThinkingLevel` and renames the Azure provider (unused here), and pi-tui's Home/End default change does not reach these tools.
- Bumped the pinned `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` devDependencies from 1.0.0 to 1.0.3.
- `web_browser`: the truncated-output file and `toFile` screenshots are written with mode `0600`, matching pi 1.0.3's user-only output files. Both were already unreadable by other users because each sits in a `0700` `mkdtemp` directory.

## [0.2.6] - 2026-10-02

### Changed

- Tested against pi 1.0.0. No break: the extension-facing declaration surface (`ToolDefinition`, `ExtensionAPI`, `ExtensionContext`, `ExtensionUIContext`, `defineTool`) is unchanged, `pi-ai`'s declaration surface is unchanged, and pi-tui's three changed declaration files are additive. The codemode tool description for each declared tool is now one line instead of a rendered TypeScript declaration, which shortens the prompt without changing what `promptGuidelines` contribute. `web_browser`'s `browser` status line is unaffected by the `tuiMode` default moving to `fullscreen`: the footer that renders it is mounted unconditionally and its renderer is unchanged.
- Bumped the pinned `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` devDependencies from 0.99.2 to 1.0.0.
- `web_browser`: added a prompt guideline that image content is not visible to a codemode script, so `screenshot` should be called directly, or with `toFile=true` to get a path the script can read.

### Fixed

- `fetch_markdown`, `pdf_extract`, `web_browser`: expanded result previews are bounded in wrapped rows at the render width instead of in characters. The 0.2.5 bound of 10 logical lines of 200 characters still rendered about 43 rows at 80 columns and 76 at 40; the body is now capped at 20 rows at any terminal width, using pi's `truncateToVisualLines`.

## [0.2.5] - 2026-09-30

### Changed

- Tested against pi 0.99.2. No break: the 0.99.1 to 0.99.2 extension API is additive only (`ToolNamespace.instructions`), and `pi-tui` and `pi-agent-core` declarations are unchanged.
- Bumped the pinned `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` devDependencies from 0.99.1 to 0.99.2.

### Fixed

- Bounded tool result and status previews. A result that is one long logical line — minified JSON, raw HTML from `get_content` — rendered as a single unbounded logical line and word-wrapped into ~1250 screen lines. An expanded preview now keeps 10 logical lines of 200 characters, and a collapsed result whose `details` cannot be rendered is clipped to 200 characters.
- `fetch_markdown`, `pdf_extract`, `web_browser`: attacker-controlled header fields are clipped to 200 characters before display. A hostile server could previously send a multi-megabyte HTTP reason phrase, and a page could carry a huge `<title>`; either one filled the screen from the collapsed one-line summary.

## [0.2.4] - 2026-09-29

### Added

- Documented pi 0.87+ `inputLimits.images.resize` for `web_browser` inline screenshots: how the active model's resize profile applies to tool-result images, a cost-saving example profile, the resize note appended to resized images, and a warning that aggressive resizing can make small page text unreadable.
- `fetch_markdown`, `pdf_extract`, `web_browser`: declare pi 0.99 tool `annotations` so permission extensions can decide which calls to confirm. `fetch_markdown` and `pdf_extract` set `readOnlyHint` and `openWorldHint`; `web_browser` sets `openWorldHint` and `readOnlyHint: false`. Older pi versions ignore the field.

### Changed

- Tested against pi 0.99; host-permission gates also apply to codemode script calls.
- Bumped the pinned `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` devDependencies from 0.86.0 to 0.99.1 so `npm run typecheck` accepts tool `annotations`.

## [0.2.3] - 2026-09-20

### Changed

- Bumped the pinned `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` devDependencies from 0.82.1 to 0.86.0 so `npm run typecheck` matches the 0.86.0 runtime API.

### Fixed

- `web_browser`, `pdf_extract`: tool result `details` no longer carry undefined-valued properties, keeping them JSON-compatible as pi 0.86.0's `ToolResultMessage.details` requires. `web_browser` omits `statusCode` for same-document navigations; `pdf_extract` omits `firstPage`/`lastPage` for a zero-page PDF and no longer prints "pages undefined-undefined" in its no-text-layer message.
- `pdf_extract`: strip `</untrusted-content` fence breaks case-insensitively so mixed-case closing tags cannot bypass sanitization.

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

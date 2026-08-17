# Changelog

## [Unreleased]

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

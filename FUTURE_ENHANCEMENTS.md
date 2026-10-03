# Future Enhancements

Candidate additions and updates, roughly ordered by impact-per-effort.

## `web_browser` additions

Lower priority:

- Storage state read (`localStorage`)
- PDF export
- Request interception/mocking
- Device-preset emulation

## New tool candidates

- **Keyless `web_search`** — the natural third leg of the suite. DuckDuckGo HTML endpoint or SearXNG needs no API key and matches the keyless positioning; results feed straight into `fetch_markdown`.
- **Feed reader** (`fetch_feed`) — RSS/Atom parsing for changelogs and release feeds; small and keyless.
- **Image generation** (rejected) — `ctx.modelRegistry.generateImages()` (pi 1.0.0+) would work with zero shimming, but it requires an OpenRouter credential and bills the session, which conflicts with the bundle's keyless positioning.

New tools should plug into the shared permission layer (`src/permissions.ts`) rather than shipping their own host gating — the single allowlist across tools is the suite's differentiator.

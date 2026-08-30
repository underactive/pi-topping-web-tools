/**
 * Browser-like HTTP headers shared by fetch_markdown and pdf_extract.
 *
 * Sending these instead of bare-minimum tool-identified headers reduces
 * the chance of being blocked by WAFs and CDNs that filter non-browser
 * User-Agents or missing auxiliary headers.
 *
 * The header set mimics Chrome ~122 on macOS, omitting Sec-Ch-Ua* (which
 * would need to stay in sync with the Chrome version) and Accept-Encoding
 * (Node's native fetch() adds its own).
 */

const DEFAULT_HEADERS: Record<string, string> = {
	Accept:
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.9",
	"Upgrade-Insecure-Requests": "1",
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
	"Sec-Fetch-Dest": "document",
	"Sec-Fetch-Mode": "navigate",
	"Sec-Fetch-Site": "none",
	"Sec-Fetch-User": "?1",
	DNT: "1",
	Priority: "u=0, i",
};

const USER_AGENT_OVERRIDE: string | undefined = process.env.PI_FETCH_USER_AGENT || undefined;

/**
 * Return a set of browser-like HTTP headers.
 *
 * When `PI_FETCH_USER_AGENT` is set in the environment, its value replaces
 * the default Chrome User-Agent while all other headers remain unchanged.
 *
 * @param userAgentOverride - optional explicit User-Agent to use instead of
 * the default Chrome macOS UA. Takes precedence over the env var when both
 * are present.
 */
export function getBrowserHeaders(userAgentOverride?: string): Record<string, string> {
	const ua = userAgentOverride ?? USER_AGENT_OVERRIDE;
	if (!ua) return DEFAULT_HEADERS;
	return { ...DEFAULT_HEADERS, "User-Agent": ua };
}
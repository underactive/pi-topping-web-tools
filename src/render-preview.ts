/**
 * Bounded previews for tool results in the TUI.
 *
 * pi 0.99.2 fixed long single-line results filling the screen for bash, codemode,
 * and MCP tool output, but that fix lives in the host's own renderers. Extension
 * tools that supply a custom `renderResult` render whatever they return, so the
 * same bound has to be applied here. Header fields need the same bound: an HTTP
 * reason phrase and a page `<title>` are attacker-controlled and can be megabytes.
 *
 * Bounds are expressed in characters rather than visual lines because pi's `Text`
 * word-wraps (and hard-breaks unspaced tokens) on render. That keeps the work
 * independent of the terminal, but rendered height still scales as
 * `characters / width`; the worst case here is about 43 lines at 80 columns and 76
 * at 40, versus the ~1250 lines a 100K-character result produced before.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

/** Logical lines shown in an expanded preview. */
export const MAX_PREVIEW_LINES = 10;

/** Characters kept per logical line in an expanded preview. */
export const MAX_PREVIEW_LINE_CHARS = 200;

/** Characters kept from a single unbounded field: a header value, status field, or collapsed body. */
export const MAX_FIELD_CHARS = 200;

export interface ResultPreview {
	/** Logical lines to display, each already clipped to {@link MAX_PREVIEW_LINE_CHARS}. */
	lines: string[];
	/** Whether logical lines were dropped by the {@link MAX_PREVIEW_LINES} cap. */
	truncated: boolean;
}

/** Concatenate a tool result's text blocks; empty when the result carries only images. */
export function resultText(content: readonly (TextContent | ImageContent)[]): string {
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** Clip one attacker-controlled field to {@link MAX_FIELD_CHARS}, marking the cut with an ellipsis. */
export function clipField(text: string): string {
	return text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS)}…` : text;
}

/**
 * Preview for an expanded tool result: at most {@link MAX_PREVIEW_LINES} logical lines,
 * each clipped so one long line cannot fill the screen. A line long enough to hit the
 * character cap loses its tail in the preview; the full text stays in the transcript.
 */
export function resultPreview(text: string): ResultPreview {
	// The limit argument keeps the split bounded on a large body: one extra element is
	// enough to detect that more lines existed.
	const all = text.split("\n", MAX_PREVIEW_LINES + 1);
	return {
		lines: all.slice(0, MAX_PREVIEW_LINES).map((line) => clipField(line)),
		truncated: all.length > MAX_PREVIEW_LINES,
	};
}
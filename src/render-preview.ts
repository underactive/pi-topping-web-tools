/**
 * Bounded previews for tool results in the TUI.
 *
 * pi 0.99.2 fixed long single-line results filling the screen for bash, codemode,
 * and MCP tool output, but that fix lives in the host's own renderers. Extension
 * tools that supply a custom `renderResult` render whatever they return, so the
 * same bound has to be applied here. Header fields need the same bound: an HTTP
 * reason phrase and a page `<title>` are attacker-controlled and can be megabytes.
 *
 * `renderResult` is not handed a width, so header fields and collapsed bodies are
 * bounded in characters. The width does reach the component it returns, through
 * `render(width)`, so an expanded body is bounded in rows there: `BoundedPreview`
 * wraps it with the host's `truncateToVisualLines`, which keeps its height the same
 * at every terminal width.
 */

import { truncateToVisualLines, type Theme } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Text, type Component } from "@earendil-works/pi-tui";

/** Body rows in an expanded preview, counted after wrapping at the render width. */
export const MAX_VISUAL_PREVIEW_LINES = 20;

/** Body characters handed to the wrapper: fills the row cap up to 400 columns without wrapping a 100K result on every redraw. */
export const MAX_PREVIEW_CHARS = 8_000;

/** Characters kept from a single unbounded field: a header value, status field, or collapsed body. */
export const MAX_FIELD_CHARS = 200;

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

export interface BoundedPreviewOptions {
	/** Styled summary; its attacker-controlled fields are already clipped. */
	header: string;
	/** Raw result text, styled dim per logical line. */
	body: string;
	/** Raw marker shown muted when the body was cut. */
	marker: string;
	/** Raw line shown dim after the body whether or not it was cut. */
	trailer?: string;
	theme: Theme;
}

/**
 * Expanded tool result: header, at most {@link MAX_VISUAL_PREVIEW_LINES} body rows, then the
 * marker and trailer. Rows depend on the width, which only `render` sees; lines are cached per
 * width because the transcript renders every result on every frame.
 */
export class BoundedPreview implements Component {
	private readonly header: string;
	private readonly body: string;
	private readonly marker: string;
	private readonly trailer: string | undefined;
	private readonly cut: boolean;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(options: BoundedPreviewOptions) {
		const { theme } = options;
		this.header = options.header;
		this.cut = options.body.length > MAX_PREVIEW_CHARS;
		// Slice the raw text before styling so the cap never cuts an escape sequence. Every logical
		// line takes at least one row, so one line past the cap is enough for the skip to register.
		this.body = options.body
			.slice(0, MAX_PREVIEW_CHARS)
			.split("\n", MAX_VISUAL_PREVIEW_LINES + 1)
			.map((line) => theme.fg("dim", line))
			.join("\n");
		this.marker = theme.fg("muted", options.marker);
		this.trailer = options.trailer === undefined ? undefined : theme.fg("dim", options.trailer);
	}

	render(width: number): string[] {
		if (this.cachedLines === undefined || this.cachedWidth !== width) {
			// paddingX 0 keeps the geometry of the `new Text(text, 0, 0)` this replaces.
			const { visualLines, skippedCount } = truncateToVisualLines(
				this.body,
				MAX_VISUAL_PREVIEW_LINES,
				width,
				0,
				"start",
			);
			const lines = [...new Text(this.header, 0, 0).render(width), ...visualLines];
			if (this.cut || skippedCount > 0) lines.push(...new Text(this.marker, 0, 0).render(width));
			if (this.trailer !== undefined) lines.push(...new Text(this.trailer, 0, 0).render(width));
			this.cachedLines = lines;
			this.cachedWidth = width;
		}
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

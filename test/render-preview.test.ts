import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentToolResult, ExtensionAPI, ExtensionFactory, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import fetchMarkdownExtension from "../src/fetch-markdown.ts";
import pdfExtractExtension from "../src/pdf-extract.ts";
import webBrowserExtension from "../src/web-browser/index.ts";
import {
	BoundedPreview,
	clipField,
	MAX_FIELD_CHARS,
	MAX_PREVIEW_CHARS,
	MAX_VISUAL_PREVIEW_LINES,
	resultText,
} from "../src/render-preview.ts";

const THEME = { fg: (_key: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

/** None of these renderers read the render context; stub it rather than build a full one. */
const RENDER_CONTEXT = {} as Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];

/** A single logical line long enough to wrap into hundreds of screen lines. */
const HUGE_LINE = "x".repeat(100_000);

/**
 * More logical lines than the row cap, each wider than any tested width, yet under
 * {@link MAX_PREVIEW_CHARS} so the row cap is what cuts it; {@link HUGE_LINE} covers the
 * character cap.
 */
const WORST_CASE_BODY = Array.from({ length: MAX_VISUAL_PREVIEW_LINES + 5 }, () => "y".repeat(300)).join("\n");

/** The widest header a tool builds: one clipped field plus fetch_markdown's fixed text. */
const WORST_CASE_HEADER = `Received 97.7KB (200 ${clipField(HUGE_LINE)}) cached truncated`;

const MARKER = "… (truncated)";

const WIDTHS = [80, 40];

/**
 * Upper bound on the rows any preview may render at any tested width: the body cap, a header
 * holding one clipped field plus ~40 characters of fixed text with one row of word-wrap slack,
 * then one marker row and one trailer row. Derived from the implementation constants, so it
 * tracks the code; {@link PREVIEW_BUDGET_CAP} is what actually pins the budget.
 */
const MAX_VISUAL_LINES = Math.max(
	...WIDTHS.map((width) => MAX_VISUAL_PREVIEW_LINES + Math.ceil((MAX_FIELD_CHARS + 50) / width) + 1 + 2),
);

/**
 * The derived bound must stay near one screen, or the budget needs a deliberate decision. A
 * typical result is 22 rows at 80 columns (header, 20 body rows, marker), inside a 24-row
 * terminal; 30 is the clipped-header worst case at 40 columns.
 */
const PREVIEW_BUDGET_CAP = 30;

test("the preview budget stays within one screen at every width", () => {
	assert.ok(
		MAX_VISUAL_LINES <= PREVIEW_BUDGET_CAP,
		`preview budget allows ${MAX_VISUAL_LINES} visual lines, above the ${PREVIEW_BUDGET_CAP} cap`,
	);
});

function toolOf(factory: ExtensionFactory): ToolDefinition {
	let tool: ToolDefinition | undefined;
	const fakePi = {
		on: () => {},
		registerCommand: () => {},
		registerTool: (candidate: ToolDefinition) => {
			tool = candidate;
		},
	} as unknown as ExtensionAPI;
	factory(fakePi);
	if (!tool) throw new Error("tool was not registered");
	return tool;
}

/** Render a tool result at each width and return the largest line count seen. */
function renderResult(tool: ToolDefinition, result: AgentToolResult, expanded: boolean): number {
	const component = tool.renderResult?.(result, { expanded, isPartial: false }, THEME, RENDER_CONTEXT);
	if (!component) throw new Error("tool has no renderResult");
	const text = component as Component;
	return Math.max(...WIDTHS.map((width) => text.render(width).length));
}

function textResult(text: string, details?: unknown): AgentToolResult {
	return {
		content: [{ type: "text", text }],
		details,
	} as unknown as AgentToolResult;
}

/** Render a preview with a one-row header and return its rows without the width padding. */
function preview(body: string, width: number, trailer?: string): string[] {
	return new BoundedPreview({ header: "Header", body, marker: MARKER, trailer, theme: THEME })
		.render(width)
		.map((line) => line.trimEnd());
}

function numberedLines(count: number): string {
	return Array.from({ length: count }, (_, i) => `line ${i}`).join("\n");
}

test("BoundedPreview caps a single long line at the row limit", () => {
	for (const width of WIDTHS) {
		const rows = preview(HUGE_LINE, width);
		assert.equal(rows.length, MAX_VISUAL_PREVIEW_LINES + 2, `rendered ${rows.length} rows at width ${width}`);
		assert.equal(rows.at(-1), MARKER);
	}
});

test("BoundedPreview drops rows past the cap and keeps the leading ones", () => {
	const rows = preview(numberedLines(40), 80);
	assert.ok(rows.includes("line 0"));
	assert.ok(rows.includes(`line ${MAX_VISUAL_PREVIEW_LINES - 1}`));
	assert.ok(!rows.includes(`line ${MAX_VISUAL_PREVIEW_LINES}`), "preview exceeded its row cap");
	assert.equal(rows.at(-1), MARKER);
});

test("BoundedPreview leaves short text intact", () => {
	assert.deepEqual(preview("one\ntwo", 80), ["Header", "one", "two"]);
});

test("BoundedPreview of an empty body adds no marker", () => {
	// The identity theme leaves no body row; the real theme's escape codes keep one blank row,
	// as before. Assert only what holds under both.
	const rows = preview("", 80);
	assert.equal(rows[0], "Header");
	assert.ok(!rows.includes(MARKER));
	assert.ok(rows.length <= 2, `rendered ${rows.length} rows`);
});

test("BoundedPreview of a body at exactly the row cap is not marked truncated", () => {
	const rows = preview(numberedLines(MAX_VISUAL_PREVIEW_LINES), 80);
	assert.equal(rows.length, MAX_VISUAL_PREVIEW_LINES + 1);
	assert.ok(!rows.includes(MARKER));
});

test("the worst-case preview stays within its ceiling at every width", () => {
	for (const body of [WORST_CASE_BODY, HUGE_LINE]) {
		const component = new BoundedPreview({
			header: WORST_CASE_HEADER,
			body,
			marker: MARKER,
			trailer: "Full: /tmp/out.txt",
			theme: THEME,
		});
		for (const width of WIDTHS) {
			const rows = component.render(width).length;
			assert.ok(rows <= MAX_VISUAL_LINES, `worst-case preview rendered ${rows} visual lines at width ${width}`);
		}
	}
});

test("BoundedPreview marks a body cut by the character cap even when the rest fits", () => {
	// At this width the kept characters fit on one row, so only the character cap can trigger the marker.
	const rows = preview("a".repeat(MAX_PREVIEW_CHARS + 1), MAX_PREVIEW_CHARS);
	assert.equal(rows.length, 3);
	assert.equal(rows.at(-1), MARKER);
});

test("BoundedPreview shows the trailer last, after the marker", () => {
	const rows = preview(numberedLines(40), 80, "Full: /tmp/out.txt");
	assert.equal(rows.at(-1), "Full: /tmp/out.txt");
	assert.equal(rows.at(-2), MARKER);
	assert.deepEqual(preview("one", 80, "Full: /tmp/out.txt"), ["Header", "one", "Full: /tmp/out.txt"]);
});

test("BoundedPreview re-wraps when the width changes", () => {
	const component = new BoundedPreview({ header: "Header", body: HUGE_LINE, marker: MARKER, theme: THEME });
	const first = component.render(80);
	assert.equal(first[1].trimEnd().length, 80);
	assert.equal(component.render(80), first, "a repeat render at the same width should reuse the cached rows");
	assert.equal(component.render(40)[1].trimEnd().length, 40);
	component.invalidate();
	assert.deepEqual(component.render(80), first);
});

test("clipField bounds long fields and keeps short ones whole", () => {
	assert.ok(clipField(HUGE_LINE).length <= MAX_FIELD_CHARS + 1);
	assert.equal(clipField("short message"), "short message");
});

test("resultText joins text blocks and ignores images", () => {
	assert.equal(resultText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");
	assert.equal(resultText([{ type: "image", data: "AAA", mimeType: "image/png" }]), "");
});

const TOOLS: [string, ToolDefinition, unknown][] = [
	[
		"fetch_markdown",
		toolOf(fetchMarkdownExtension),
		{ url: "https://example.com", code: 200, codeText: "OK", bytes: 100_000, durationMs: 1 },
	],
	[
		"pdf_extract",
		toolOf(pdfExtractExtension),
		{ source: "https://example.com/a.pdf", totalPages: 10, pageCount: 10, bytes: 100_000, durationMs: 1 },
	],
	["web_browser", toolOf(webBrowserExtension), { action: "get_content", bytes: 100_000 }],
];

for (const [name, tool, details] of TOOLS) {
	for (const expanded of [false, true]) {
		for (const [bodyLabel, body] of [
			["a single-line 100K result", HUGE_LINE],
			["a worst-case multi-line result", WORST_CASE_BODY],
		] as const) {
			test(`${name} bounds ${bodyLabel} (expanded=${expanded})`, () => {
				// A details-less result falls back to the raw text; it must stay bounded too.
				for (const withDetails of [details, undefined]) {
					const lines = renderResult(tool, textResult(body, withDetails), expanded);
					assert.ok(
						lines <= MAX_VISUAL_LINES,
						`rendered ${lines} visual lines (details=${withDetails ? "yes" : "no"})`,
					);
				}
			});
		}
	}
}

test("fetch_markdown bounds an attacker-supplied HTTP reason phrase", () => {
	const details = { url: "https://example.com", code: 200, codeText: HUGE_LINE, bytes: 10, durationMs: 1 };
	for (const expanded of [false, true]) {
		const lines = renderResult(toolOf(fetchMarkdownExtension), textResult("body", details), expanded);
		assert.ok(lines <= MAX_VISUAL_LINES, `rendered ${lines} visual lines (expanded=${expanded})`);
	}
});

test("web_browser bounds an attacker-supplied page title", () => {
	const details = { action: "navigate", title: HUGE_LINE, url: "https://example.com" };
	for (const expanded of [false, true]) {
		const lines = renderResult(toolOf(webBrowserExtension), textResult("body", details), expanded);
		assert.ok(lines <= MAX_VISUAL_LINES, `rendered ${lines} visual lines (expanded=${expanded})`);
	}
});

test("web_browser bounds an error message", () => {
	const details = { action: "navigate", error: HUGE_LINE };
	const lines = renderResult(toolOf(webBrowserExtension), textResult("body", details), false);
	assert.ok(lines <= MAX_VISUAL_LINES, `rendered ${lines} visual lines`);
});

test("fetch_markdown still shows a short details-less message in full", () => {
	const lines = renderResult(toolOf(fetchMarkdownExtension), textResult("REDIRECT DETECTED: try again"), false);
	assert.ok(lines <= 1);
});

test("fetch_markdown expanded preview shows the leading lines and marks truncation", () => {
	const details = { url: "https://example.com", code: 200, codeText: "OK", bytes: 100_000, durationMs: 1 };
	const tool = toolOf(fetchMarkdownExtension);
	const component = tool.renderResult?.(
		{ content: [{ type: "text", text: numberedLines(40) }], details } as unknown as AgentToolResult,
		{ expanded: true, isPartial: false },
		THEME,
		RENDER_CONTEXT,
	) as Component;
	const lines = component.render(80).map((line) => line.trimEnd());
	assert.ok(lines[0].startsWith("Received "), `header was ${lines[0]}`);
	assert.ok(lines.includes("line 0"));
	assert.ok(lines.includes(`line ${MAX_VISUAL_PREVIEW_LINES - 1}`));
	assert.ok(!lines.includes(`line ${MAX_VISUAL_PREVIEW_LINES}`), "preview exceeded its row cap");
	assert.ok(lines.includes(MARKER));
});

test("web_browser expanded preview keeps the full-output path below the marker", () => {
	const details = { action: "get_content", bytes: 100_000, fullOutputPath: "/tmp/pi-web-browser-x/out.html" };
	const tool = toolOf(webBrowserExtension);
	const component = tool.renderResult?.(
		{ content: [{ type: "text", text: numberedLines(40) }], details } as unknown as AgentToolResult,
		{ expanded: true, isPartial: false },
		THEME,
		RENDER_CONTEXT,
	) as Component;
	const lines = component.render(40).map((line) => line.trimEnd());
	assert.equal(lines.at(-1), "Full: /tmp/pi-web-browser-x/out.html");
	assert.equal(lines.at(-2), "…");
	assert.ok(lines.length <= MAX_VISUAL_LINES, `rendered ${lines.length} visual lines`);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentToolResult, ExtensionAPI, ExtensionFactory, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import fetchMarkdownExtension from "../src/fetch-markdown.ts";
import pdfExtractExtension from "../src/pdf-extract.ts";
import webBrowserExtension from "../src/web-browser/index.ts";
import { clipField, MAX_FIELD_CHARS, MAX_PREVIEW_LINE_CHARS, MAX_PREVIEW_LINES, resultPreview, resultText } from "../src/render-preview.ts";

const THEME = { fg: (_key: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

/** None of these renderers read the render context; stub it rather than build a full one. */
const RENDER_CONTEXT = {} as Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];

/** A single logical line long enough to wrap into hundreds of screen lines. */
const HUGE_LINE = "x".repeat(100_000);

/** Worst case an expanded preview may produce: every kept line at the per-line clip. */
const WORST_CASE_BODY = Array.from({ length: MAX_PREVIEW_LINES }, () => "y".repeat(MAX_PREVIEW_LINE_CHARS + 50)).join("\n");

const WIDTHS = [80, 40];

/**
 * Upper bound on the visual lines any preview may render at any tested width: every kept
 * line wraps to `ceil(chars / width)` rows, plus the header and one clip marker. Derived
 * from the implementation constants, so it tracks the code; {@link PREVIEW_BUDGET_CAP} is
 * what actually pins the budget.
 */
const MAX_VISUAL_LINES = Math.max(
	...WIDTHS.map((width) => (Math.ceil((MAX_PREVIEW_LINE_CHARS + 1) / width) + 1) * MAX_PREVIEW_LINES + Math.ceil((MAX_FIELD_CHARS + 1) / width)),
);

/** The derived bound must stay near one screen, or the budget needs a deliberate decision. */
const PREVIEW_BUDGET_CAP = 80;

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

test("resultPreview clips a single long logical line", () => {
	const preview = resultPreview(HUGE_LINE);
	assert.equal(preview.lines.length, 1);
	assert.ok(preview.lines[0].length <= MAX_PREVIEW_LINE_CHARS + 1, `line was ${preview.lines[0].length} chars`);
	// Only the line cap drives the marker; an in-place clip is already marked inline.
	assert.equal(preview.truncated, false);
});

test("resultPreview drops logical lines past the cap", () => {
	const preview = resultPreview(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"));
	assert.equal(preview.lines.length, MAX_PREVIEW_LINES);
	assert.deepEqual(preview.lines[0], "line 0");
	assert.equal(preview.truncated, true);
});

test("resultPreview leaves short text intact", () => {
	const preview = resultPreview("one\ntwo");
	assert.deepEqual(preview.lines, ["one", "two"]);
	assert.equal(preview.truncated, false);
});

test("resultPreview of an empty body is a single blank line", () => {
	assert.deepEqual(resultPreview(""), { lines: [""], truncated: false });
});

test("resultPreview of a body at exactly the cap is not marked truncated", () => {
	const preview = resultPreview(Array.from({ length: MAX_PREVIEW_LINES }, (_, i) => `line ${i}`).join("\n"));
	assert.equal(preview.lines.length, MAX_PREVIEW_LINES);
	assert.equal(preview.truncated, false);
});

test("the worst-case preview stays within its ceiling at every width", () => {
	const text = resultPreview(WORST_CASE_BODY).lines.join("\n");
	for (const width of WIDTHS) {
		const lines = new Text(text, 0, 0).render(width);
		assert.ok(
			lines.length <= MAX_VISUAL_LINES,
			`worst-case preview rendered ${lines.length} visual lines at width ${width}`,
		);
	}
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
	const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
	const details = { url: "https://example.com", code: 200, codeText: "OK", bytes: 100_000, durationMs: 1 };
	const tool = toolOf(fetchMarkdownExtension);
	const component = tool.renderResult?.(
		{ content: [{ type: "text", text: body }], details } as unknown as AgentToolResult,
		{ expanded: true, isPartial: false },
		THEME,
		RENDER_CONTEXT,
	) as Component;
	const lines = component.render(80).map((line) => line.trimEnd());
	assert.ok(lines[0].startsWith("Received "), `header was ${lines[0]}`);
	assert.ok(lines.includes("line 0"));
	assert.ok(lines.includes("line 9"));
	assert.ok(!lines.includes("line 10"), "preview exceeded its line cap");
	assert.ok(lines.includes("… (truncated)"));
});
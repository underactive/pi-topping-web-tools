import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import fetchMarkdownExtension from "../src/fetch-markdown.ts";
import pdfExtractExtension from "../src/pdf-extract.ts";
import webBrowserExtension from "../src/web-browser/index.ts";

function registeredTool(factory: ExtensionFactory): ToolDefinition {
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

test("fetch_markdown is annotated read-only and open-world", () => {
	assert.deepEqual(registeredTool(fetchMarkdownExtension).annotations, { readOnlyHint: true, openWorldHint: true });
});

test("pdf_extract is annotated read-only and open-world", () => {
	assert.deepEqual(registeredTool(pdfExtractExtension).annotations, { readOnlyHint: true, openWorldHint: true });
});

test("web_browser is annotated open-world and not read-only", () => {
	assert.deepEqual(registeredTool(webBrowserExtension).annotations, { readOnlyHint: false, openWorldHint: true });
});

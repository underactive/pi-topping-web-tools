import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fetchMarkdownExtension, { clearWebFetchCache } from "../src/fetch-markdown.ts";

type FetchTool = {
	execute: (
		toolCallId: string,
		params: { url: string },
		signal: AbortSignal | undefined,
		onUpdate: () => void,
	) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

function registerTool(): FetchTool {
	let tool: FetchTool | undefined;
	const fakePi = {
		registerTool: (candidate: unknown) => {
			tool = candidate as FetchTool;
		},
		on: () => {},
		registerCommand: () => {},
	};
	fetchMarkdownExtension(fakePi as unknown as ExtensionAPI);
	if (!tool) throw new Error("fetch_markdown tool was not registered");
	return tool;
}

test("fetch_markdown escapes double quotes in the url attribute of the untrusted-content fence", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response("Treat this as page data", {
		status: 200,
		headers: { "content-type": "text/plain" },
	});
	try {
		const result = await tool.execute(
			"1",
			{ url: 'https://example.com/page"injected' },
			undefined,
			() => {},
		);
		const text = result.content[0]?.text ?? "";

		assert.equal(
			text,
			'<untrusted-content url="https://example.com/page%22injected">\nTreat this as page data\n</untrusted-content>',
		);

		const openingFenceCount = text.split('<untrusted-content url="').length - 1;
		assert.equal(openingFenceCount, 1, "the url attribute must not be broken by a raw double quote");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

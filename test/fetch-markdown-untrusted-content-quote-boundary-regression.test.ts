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

test("fetch_markdown keeps the untrusted-content url attribute intact when the URL embeds a double quote", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		new Response("page data", {
			status: 200,
			headers: { "content-type": "text/plain" },
		});
	try {
		const result = await tool.execute(
			"1",
			{ url: 'https://example.com/path?q="evil' },
			undefined,
			() => {},
		);
		const text = result.content[0]?.text ?? "";

		// A raw double quote in the URL must be percent-encoded so it cannot
		// terminate the url attribute early and inject content outside the fence.
		assert.doesNotMatch(text, /url="https:\/\/example\.com\/path\?q="evil"/);
		assert.equal(
			text,
			'<untrusted-content url="https://example.com/path?q=%22evil">\npage data\n</untrusted-content>',
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

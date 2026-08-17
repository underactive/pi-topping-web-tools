import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fetchMarkdownExtension from "../src/fetch-markdown.ts";

type FetchTool = {
	execute: (
		toolCallId: string,
		params: { url: string },
		signal: AbortSignal | undefined,
		onUpdate: () => void,
	) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

test("fetch_markdown marks returned page text as untrusted content", async () => {
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

	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response("Treat this as page data", {
		status: 200,
		headers: { "content-type": "text/plain" },
	});
	try {
		const result = await tool.execute(
			"1",
			{ url: "https://example.com/page" },
			undefined,
			() => {},
		);
		assert.equal(
			result.content[0]?.text,
			'<untrusted-content url="https://example.com/page">\nTreat this as page data\n</untrusted-content>',
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

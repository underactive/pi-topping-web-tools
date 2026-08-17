import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fetchMarkdownExtension, { clearWebFetchCache, MAX_MARKDOWN_LENGTH } from "../src/fetch-markdown.ts";

type FetchDetails = {
	cached?: boolean;
	totalChars?: number;
	offset?: number;
	truncated?: boolean;
};

type FetchTool = {
	execute: (
		toolCallId: string,
		params: { url: string; offset?: number; raw?: boolean },
		signal: AbortSignal | undefined,
		onUpdate: () => void,
	) => Promise<{ content: Array<{ type: string; text: string }>; details?: FetchDetails }>;
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

const LONG_CONTENT = "a".repeat(MAX_MARKDOWN_LENGTH * 2 + 50_000);

function stubFetch(body: string): { calls: () => number; restore: () => void } {
	const originalFetch = globalThis.fetch;
	let count = 0;
	globalThis.fetch = async () => {
		count += 1;
		return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
	};
	return { calls: () => count, restore: () => (globalThis.fetch = originalFetch) };
}

test("truncated response reports the next offset", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	const stub = stubFetch(LONG_CONTENT);
	try {
		const result = await tool.execute("1", { url: "https://example.com/long" }, undefined, () => {});
		const text = result.content[0]?.text ?? "";
		assert.ok(
			text.includes(
				`[Showing characters 0–${MAX_MARKDOWN_LENGTH} of ${LONG_CONTENT.length}. Use offset=${MAX_MARKDOWN_LENGTH} to continue.]`,
			),
		);
		assert.equal(result.details?.truncated, true);
		assert.equal(result.details?.totalChars, LONG_CONTENT.length);
	} finally {
		stub.restore();
	}
});

test("offset continuation is served from cache", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	const stub = stubFetch(LONG_CONTENT);
	try {
		await tool.execute("1", { url: "https://example.com/long-cached" }, undefined, () => {});
		const result = await tool.execute(
			"2",
			{ url: "https://example.com/long-cached", offset: MAX_MARKDOWN_LENGTH },
			undefined,
			() => {},
		);
		assert.equal(stub.calls(), 1);
		const text = result.content[0]?.text ?? "";
		assert.ok(
			text.includes(
				`[Showing characters ${MAX_MARKDOWN_LENGTH}–${MAX_MARKDOWN_LENGTH * 2} of ${LONG_CONTENT.length}. Use offset=${MAX_MARKDOWN_LENGTH * 2} to continue.]`,
			),
		);
		assert.equal(result.details?.cached, true);
	} finally {
		stub.restore();
	}
});

test("offset beyond the end returns a message instead of throwing", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	const stub = stubFetch("short content");
	try {
		const result = await tool.execute(
			"1",
			{ url: "https://example.com/short", offset: 500 },
			undefined,
			() => {},
		);
		const text = result.content[0]?.text ?? "";
		assert.ok(text.includes("[Offset 500 is beyond the end of the content (13 characters total).]"));
		assert.equal(result.details?.truncated, false);
	} finally {
		stub.restore();
	}
});

test("negative and fractional offsets are clamped", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	const stub = stubFetch("hello world");
	try {
		const negative = await tool.execute(
			"1",
			{ url: "https://example.com/clamp", offset: -50 },
			undefined,
			() => {},
		);
		assert.ok(negative.content[0]?.text.includes("hello world"));
		assert.equal(negative.details?.offset, 0);

		const fractional = await tool.execute(
			"2",
			{ url: "https://example.com/clamp", offset: 6.9 },
			undefined,
			() => {},
		);
		assert.ok(fractional.content[0]?.text.includes("world"));
		assert.equal(fractional.details?.offset, 6);
	} finally {
		stub.restore();
	}
});

test("final window has no truncation notice", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	const stub = stubFetch(LONG_CONTENT);
	try {
		const result = await tool.execute(
			"1",
			{ url: "https://example.com/final-window", offset: MAX_MARKDOWN_LENGTH * 2 },
			undefined,
			() => {},
		);
		const text = result.content[0]?.text ?? "";
		assert.ok(!text.includes("to continue"));
		assert.equal(result.details?.truncated, false);
	} finally {
		stub.restore();
	}
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fetchMarkdownExtension, {
	_expireCacheEntryForTests,
	clearWebFetchCache,
	MAX_MARKDOWN_LENGTH,
} from "../src/fetch-markdown.ts";

type FetchDetails = { cached?: boolean };

type FetchTool = {
	execute: (
		toolCallId: string,
		params: { url: string; offset?: number },
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

type StubResponse = { body: string | null; status: number; headers?: Record<string, string> };

function stubFetch(responses: StubResponse[]): {
	requests: Array<Headers>;
	restore: () => void;
} {
	const originalFetch = globalThis.fetch;
	const requests: Array<Headers> = [];
	let index = 0;
	globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
		requests.push(new Headers(init?.headers));
		const next = responses[Math.min(index, responses.length - 1)];
		index += 1;
		if (!next) throw new Error("no stub response configured");
		return new Response(next.body, {
			status: next.status,
			headers: { "content-type": "text/plain", ...next.headers },
		});
	};
	return { requests, restore: () => (globalThis.fetch = originalFetch) };
}

test("stale entry with ETag revalidates via If-None-Match and reuses content on 304", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	const stub = stubFetch([
		{ body: "etag content", status: 200, headers: { etag: '"v1"' } },
		{ body: null, status: 304 },
	]);
	try {
		const url = "https://example.com/etag";
		await tool.execute("1", { url }, undefined, () => {});
		_expireCacheEntryForTests(url);
		const result = await tool.execute("2", { url }, undefined, () => {});
		assert.equal(stub.requests.length, 2);
		assert.equal(stub.requests[1]?.get("if-none-match"), '"v1"');
		assert.ok(result.content[0]?.text.includes("etag content"));
		assert.equal(result.details?.cached, true);
	} finally {
		stub.restore();
	}
});

test("stale entry with Last-Modified revalidates via If-Modified-Since", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	const stamp = "Mon, 03 Aug 2026 12:00:00 GMT";
	const stub = stubFetch([
		{ body: "dated content", status: 200, headers: { "last-modified": stamp } },
		{ body: null, status: 304 },
	]);
	try {
		const url = "https://example.com/last-modified";
		await tool.execute("1", { url }, undefined, () => {});
		_expireCacheEntryForTests(url);
		const result = await tool.execute("2", { url }, undefined, () => {});
		assert.equal(stub.requests[1]?.get("if-modified-since"), stamp);
		assert.ok(result.content[0]?.text.includes("dated content"));
		assert.equal(result.details?.cached, true);
	} finally {
		stub.restore();
	}
});

test("stale entry replaced when server returns 200 with new content", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	const stub = stubFetch([
		{ body: "old content", status: 200, headers: { etag: '"v1"' } },
		{ body: "new content", status: 200, headers: { etag: '"v2"' } },
	]);
	try {
		const url = "https://example.com/changed";
		await tool.execute("1", { url }, undefined, () => {});
		_expireCacheEntryForTests(url);
		const result = await tool.execute("2", { url }, undefined, () => {});
		assert.ok(result.content[0]?.text.includes("new content"));
		assert.equal(result.details?.cached, false);
	} finally {
		stub.restore();
	}
});

test("stale entry without validators refetches unconditionally", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	const stub = stubFetch([
		{ body: "no validators", status: 200 },
		{ body: "no validators refetched", status: 200 },
	]);
	try {
		const url = "https://example.com/no-validators";
		await tool.execute("1", { url }, undefined, () => {});
		_expireCacheEntryForTests(url);
		const result = await tool.execute("2", { url }, undefined, () => {});
		assert.equal(stub.requests[1]?.get("if-none-match"), null);
		assert.equal(stub.requests[1]?.get("if-modified-since"), null);
		assert.ok(result.content[0]?.text.includes("no validators refetched"));
		assert.equal(result.details?.cached, false);
	} finally {
		stub.restore();
	}
});

test("fresh cache hit makes no network request", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	const stub = stubFetch([{ body: "fresh content", status: 200 }]);
	try {
		const url = "https://example.com/fresh";
		await tool.execute("1", { url }, undefined, () => {});
		const result = await tool.execute("2", { url }, undefined, () => {});
		assert.equal(stub.requests.length, 1);
		assert.equal(result.details?.cached, true);
	} finally {
		stub.restore();
	}
});

test("revalidated content remains sliceable past the truncation limit", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	const longBody = "b".repeat(MAX_MARKDOWN_LENGTH + 25_000);
	const stub = stubFetch([
		{ body: longBody, status: 200, headers: { etag: '"long"' } },
		{ body: null, status: 304 },
	]);
	try {
		const url = "https://example.com/long-revalidated";
		await tool.execute("1", { url }, undefined, () => {});
		_expireCacheEntryForTests(url);
		const result = await tool.execute("2", { url, offset: MAX_MARKDOWN_LENGTH }, undefined, () => {});
		assert.equal(stub.requests.length, 2);
		assert.equal(stub.requests[1]?.get("if-none-match"), '"long"');
		const text = result.content[0]?.text ?? "";
		assert.ok(text.includes("b".repeat(1000)));
		assert.ok(!text.includes("to continue"));
		assert.equal(result.details?.cached, true);
	} finally {
		stub.restore();
	}
});

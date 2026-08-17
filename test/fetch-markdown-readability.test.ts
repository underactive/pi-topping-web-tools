import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fetchMarkdownExtension, { clearWebFetchCache } from "../src/fetch-markdown.ts";

type FetchTool = {
	execute: (
		toolCallId: string,
		params: { url: string; raw?: boolean },
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

const ARTICLE_HTML = readFileSync(new URL("./fixtures/readability-article.html", import.meta.url), "utf-8");

function stubFetch(body: string, contentType = "text/html"): { calls: () => number; restore: () => void } {
	const originalFetch = globalThis.fetch;
	let count = 0;
	globalThis.fetch = async () => {
		count += 1;
		return new Response(body, { status: 200, headers: { "content-type": contentType } });
	};
	return { calls: () => count, restore: () => (globalThis.fetch = originalFetch) };
}

test("readability extraction strips nav and footer boilerplate by default", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	const stub = stubFetch(ARTICLE_HTML);
	try {
		const result = await tool.execute("1", { url: "https://example.com/article" }, undefined, () => {});
		const text = result.content[0]?.text ?? "";
		assert.ok(
			text.startsWith(
				'<untrusted-content url="https://example.com/article">\nUnderstanding Cache Revalidation\n',
			),
		);
		assert.equal(text.match(/Understanding Cache Revalidation/g)?.length, 1);
		assert.ok(text.includes("ArticleBodyMarkerText"));
		assert.ok(text.includes("Conditional requests carry validators"));
		assert.ok(!text.includes("SiteNavHome"));
		assert.ok(!text.includes("FooterCopyrightText"));
	} finally {
		stub.restore();
	}
});

test("raw: true converts the full page including nav", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	const stub = stubFetch(ARTICLE_HTML);
	try {
		const result = await tool.execute(
			"1",
			{ url: "https://example.com/article-raw", raw: true },
			undefined,
			() => {},
		);
		const text = result.content[0]?.text ?? "";
		assert.ok(text.includes("SiteNavHome"));
		assert.ok(text.includes("ArticleBodyMarkerText"));
	} finally {
		stub.restore();
	}
});

test("non-article page falls back to full-page conversion", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	const sparse = "<html><body><ul><li><a href='/a'>LinkAlpha</a></li><li><a href='/b'>LinkBeta</a></li></ul></body></html>";
	const stub = stubFetch(sparse);
	try {
		const result = await tool.execute("1", { url: "https://example.com/links" }, undefined, () => {});
		const text = result.content[0]?.text ?? "";
		assert.ok(text.includes("LinkAlpha"));
		assert.ok(text.includes("LinkBeta"));
	} finally {
		stub.restore();
	}
});

test("default and raw variants are cached independently", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	const stub = stubFetch(ARTICLE_HTML);
	try {
		const url = "https://example.com/article-variants";
		await tool.execute("1", { url }, undefined, () => {});
		await tool.execute("2", { url, raw: true }, undefined, () => {});
		assert.equal(stub.calls(), 2);
		await tool.execute("3", { url }, undefined, () => {});
		await tool.execute("4", { url, raw: true }, undefined, () => {});
		assert.equal(stub.calls(), 2);
	} finally {
		stub.restore();
	}
});

test("text/plain content is passed through without extraction", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	const stub = stubFetch("plain text with <article>fake tags</article>", "text/plain");
	try {
		const result = await tool.execute("1", { url: "https://example.com/plain" }, undefined, () => {});
		const text = result.content[0]?.text ?? "";
		assert.ok(text.includes("plain text with <article>fake tags</article>"));
	} finally {
		stub.restore();
	}
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fetchMarkdownExtension, {
	_activeFetchCountForTests,
	clearWebFetchCache,
	isPermittedRedirect,
} from "../src/fetch-markdown.ts";

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

type StubResponse = {
	body: BodyInit | null;
	status: number;
	headers?: Record<string, string>;
};

function stubFetch(responses: StubResponse[]): {
	urls: string[];
	restore: () => void;
} {
	const originalFetch = globalThis.fetch;
	const urls: string[] = [];
	let index = 0;
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		urls.push(String(input));
		const next = responses[Math.min(index, responses.length - 1)];
		index += 1;
		if (!next) throw new Error("no stub response configured");
		return new Response(next.body, {
			status: next.status,
			headers: { "content-type": "text/plain", ...next.headers },
		});
	};
	return { urls, restore: () => (globalThis.fetch = originalFetch) };
}

test("isPermittedRedirect blocks cross-host redirects", () => {
	assert.equal(isPermittedRedirect("https://example.com/a", "https://other.example/b"), false);
	assert.equal(isPermittedRedirect("https://example.com/a", "https://sub.example.com/b"), false);
});

test("isPermittedRedirect blocks scheme and port changes", () => {
	assert.equal(isPermittedRedirect("https://example.com/", "http://example.com/"), false);
	assert.equal(isPermittedRedirect("https://example.com/", "https://example.com:8443/"), false);
});

test("isPermittedRedirect blocks credentials in the redirect target", () => {
	assert.equal(isPermittedRedirect("https://example.com/", "https://user:pass@example.com/"), false);
});

test("isPermittedRedirect allows www-stripped hostname equivalence", () => {
	assert.equal(isPermittedRedirect("https://example.com/a", "https://www.example.com/b"), true);
	assert.equal(isPermittedRedirect("https://www.example.com/a", "https://example.com/b"), true);
});

test("isPermittedRedirect requires preapproved redirects to stay preapproved", () => {
	assert.equal(isPermittedRedirect("https://vercel.com/docs/a", "https://vercel.com/pricing"), false);
	assert.equal(isPermittedRedirect("https://vercel.com/docs/a", "https://vercel.com/docs/b"), true);
});

test("permitted same-host redirect is followed", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	const stub = stubFetch([
		{ body: null, status: 301, headers: { location: "https://example.com/final" } },
		{ body: "redirected content", status: 200 },
	]);
	try {
		const result = await tool.execute("1", { url: "https://example.com/start" }, undefined, () => {});
		assert.ok(result.content[0]?.text.includes("redirected content"));
		assert.deepEqual(stub.urls, ["https://example.com/start", "https://example.com/final"]);
	} finally {
		stub.restore();
	}
});

test("cross-host redirect yields REDIRECT DETECTED instead of following", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	const stub = stubFetch([
		{ body: null, status: 301, headers: { location: "https://other.example/evil" } },
	]);
	try {
		const result = await tool.execute("1", { url: "https://example.com/start" }, undefined, () => {});
		assert.match(result.content[0]?.text ?? "", /REDIRECT DETECTED/);
		assert.match(result.content[0]?.text ?? "", /https:\/\/other\.example\/evil/);
		assert.equal(stub.urls.length, 1);
	} finally {
		stub.restore();
	}
});

test("redirect without a Location header throws", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	const stub = stubFetch([{ body: null, status: 302 }]);
	try {
		await assert.rejects(
			tool.execute("1", { url: "https://example.com/no-location" }, undefined, () => {}),
			/Redirect missing Location header/,
		);
	} finally {
		stub.restore();
	}
});

test("more than MAX_REDIRECTS hops throws", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	const loops = Array.from({ length: 12 }, () => ({
		body: null,
		status: 302,
		headers: { location: "https://example.com/loop" },
	}));
	const stub = stubFetch(loops);
	try {
		await assert.rejects(
			tool.execute("1", { url: "https://example.com/loop" }, undefined, () => {}),
			/Too many redirects/,
		);
	} finally {
		stub.restore();
	}
});

test("binary content types yield a placeholder instead of raw bytes", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	const stub = stubFetch([
		{ body: "abcd", status: 200, headers: { "content-type": "image/png" } },
	]);
	try {
		const result = await tool.execute("1", { url: "https://example.com/image.png" }, undefined, () => {});
		assert.ok(
			result.content[0]?.text.includes("[Binary content (image/png, 4B) cannot be displayed.]"),
		);
	} finally {
		stub.restore();
	}
});

test("text-like content types are returned as content", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	const types = [
		"text/plain",
		"application/json",
		"application/ld+json",
		"application/xml",
		"application/atom+xml",
		"application/javascript",
		"application/x-www-form-urlencoded",
	];
	for (const [index, contentType] of types.entries()) {
		const stub = stubFetch([
			{ body: `payload-${index}`, status: 200, headers: { "content-type": contentType } },
		]);
		try {
			const result = await tool.execute(
				"1",
				{ url: `https://example.com/type-${index}` },
				undefined,
				() => {},
			);
			assert.ok(
				result.content[0]?.text.includes(`payload-${index}`),
				`${contentType} should be treated as text`,
			);
		} finally {
			stub.restore();
		}
	}
});

test("http URLs are requested as https", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	const stub = stubFetch([{ body: "upgraded", status: 200 }]);
	try {
		const result = await tool.execute("1", { url: "http://example.com/upgrade-path" }, undefined, () => {});
		assert.deepEqual(stub.urls, ["https://example.com/upgrade-path"]);
		assert.ok(result.content[0]?.text.includes("upgraded"));
	} finally {
		stub.restore();
	}
});

test("content-length header over the limit is rejected before reading the body", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	const stub = stubFetch([
		{ body: "tiny", status: 200, headers: { "content-length": "30000000" } },
	]);
	try {
		await assert.rejects(
			tool.execute("1", { url: "https://example.com/too-big-header" }, undefined, () => {}),
			/Response too large/,
		);
		assert.equal(stub.urls.length, 1);
	} finally {
		stub.restore();
	}
});

test("streamed body over the limit is rejected", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	const oversized = new Uint8Array(25 * 1024 * 1024 + 1);
	const stub = stubFetch([
		{
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(oversized);
					controller.close();
				},
			}),
			status: 200,
		},
	]);
	try {
		await assert.rejects(
			tool.execute("1", { url: "https://example.com/too-big-stream" }, undefined, () => {}),
			/Response too large/,
		);
	} finally {
		stub.restore();
	}
});

test("already-aborted signal rejects the fetch and leaves no active fetches", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	let capturedSignal: AbortSignal | undefined;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
		capturedSignal = init?.signal ?? undefined;
		if (capturedSignal?.aborted) {
			throw new DOMException("The operation was aborted.", "AbortError");
		}
		return new Response("unreachable", { status: 200 });
	};
	try {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			tool.execute("1", { url: "https://example.com/already-aborted" }, controller.signal, () => {}),
			(err: unknown) => err instanceof DOMException && err.name === "AbortError",
		);
		assert.equal(capturedSignal?.aborted, true);
		assert.equal(_activeFetchCountForTests(), 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("mid-flight abort aborts the fetch and cleans up active fetches", async () => {
	clearWebFetchCache();
	const tool = registerTool();
	let capturedSignal: AbortSignal | undefined;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (_input: RequestInfo | URL, init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			capturedSignal = init?.signal ?? undefined;
			capturedSignal?.addEventListener(
				"abort",
				() => reject(new DOMException("The operation was aborted.", "AbortError")),
				{ once: true },
			);
		});
	try {
		const controller = new AbortController();
		const pending = tool.execute(
			"1",
			{ url: "https://example.com/mid-flight-abort" },
			controller.signal,
			() => {},
		);
		controller.abort();
		await assert.rejects(
			pending,
			(err: unknown) => err instanceof DOMException && err.name === "AbortError",
		);
		assert.equal(capturedSignal?.aborted, true);
		assert.equal(_activeFetchCountForTests(), 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

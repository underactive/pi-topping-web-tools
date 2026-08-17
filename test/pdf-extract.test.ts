import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFile, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pdfExtractExtension, {
	clearPdfExtractCache,
	looksLikePdf,
	parsePageRange,
} from "../src/pdf-extract.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "sample.pdf");
const FIXTURE_BYTES = new Uint8Array(readFileSync(FIXTURE_PATH));

type PdfDetails = {
	totalPages?: number;
	pageCount?: number;
	firstPage?: number;
	lastPage?: number;
	cached?: boolean;
	totalChars?: number;
	offset?: number;
	truncated?: boolean;
};

type PdfTool = {
	execute: (
		toolCallId: string,
		params: { url?: string; path?: string; pages?: string; offset?: number },
		signal: AbortSignal | undefined,
		onUpdate: () => void,
	) => Promise<{ content: Array<{ type: string; text: string }>; details?: PdfDetails }>;
};

function registerTool(): PdfTool {
	let tool: PdfTool | undefined;
	const fakePi = {
		registerTool: (candidate: unknown) => {
			tool = candidate as PdfTool;
		},
		on: () => {},
		registerCommand: () => {},
	};
	pdfExtractExtension(fakePi as unknown as ExtensionAPI);
	if (!tool) throw new Error("pdf_extract tool was not registered");
	return tool;
}

function stubFetch(body: BodyInit, headers: Record<string, string> = {}): { calls: () => number; restore: () => void } {
	const originalFetch = globalThis.fetch;
	let count = 0;
	globalThis.fetch = async () => {
		count += 1;
		return new Response(body, {
			status: 200,
			headers: { "content-type": "application/pdf", ...headers },
		});
	};
	return { calls: () => count, restore: () => (globalThis.fetch = originalFetch) };
}

// --- parsePageRange ---

test("parsePageRange handles single pages, ranges, and comma lists", () => {
	assert.deepEqual(parsePageRange("3", 10), [3]);
	assert.deepEqual(parsePageRange("1-5", 10), [1, 2, 3, 4, 5]);
	assert.deepEqual(parsePageRange("1,4,7-9", 10), [1, 4, 7, 8, 9]);
});

test("parsePageRange dedupes, sorts, and clamps to the document length", () => {
	assert.deepEqual(parsePageRange("3,1,2,2", 10), [1, 2, 3]);
	assert.deepEqual(parsePageRange("8-99", 10), [8, 9, 10]);
});

test("parsePageRange rejects malformed and out-of-range specs", () => {
	assert.throws(() => parsePageRange("abc", 10), /Invalid pages value/);
	assert.throws(() => parsePageRange("0", 10), /1-based/);
	assert.throws(() => parsePageRange("5-2", 10), /Invalid page range/);
	assert.throws(() => parsePageRange("50", 10), /No pages selected/);
});

// --- looksLikePdf ---

test("looksLikePdf accepts the fixture and rejects HTML", () => {
	assert.equal(looksLikePdf(FIXTURE_BYTES), true);
	assert.equal(looksLikePdf(Buffer.from("<!doctype html><html></html>")), false);
});

// --- extraction ---

test("extracts text from a local PDF with page markers", async () => {
	clearPdfExtractCache();
	const tool = registerTool();
	const result = await tool.execute("1", { path: FIXTURE_PATH }, undefined, () => {});
	const text = result.content[0]?.text ?? "";

	assert.ok(text.includes("--- Page 1 ---"));
	assert.ok(text.includes("--- Page 2 ---"));
	assert.ok(text.includes("--- Page 3 ---"));
	assert.ok(text.includes("ALPHA_PAGE_ONE"));
	assert.ok(text.includes("BRAVO_PAGE_TWO"));
	assert.ok(text.includes("CHARLIE_PAGE_THREE"));
	assert.equal(result.details?.totalPages, 3);
	assert.equal(result.details?.pageCount, 3);
});

test("output is wrapped in untrusted-content", async () => {
	clearPdfExtractCache();
	const tool = registerTool();
	const result = await tool.execute("1", { path: FIXTURE_PATH }, undefined, () => {});
	const text = result.content[0]?.text ?? "";
	assert.ok(text.startsWith("<untrusted-content "));
	assert.ok(text.trimEnd().endsWith("</untrusted-content>"));
});

test("pages parameter limits extraction to the requested range", async () => {
	clearPdfExtractCache();
	const tool = registerTool();
	const result = await tool.execute("1", { path: FIXTURE_PATH, pages: "2" }, undefined, () => {});
	const text = result.content[0]?.text ?? "";

	assert.ok(text.includes("BRAVO_PAGE_TWO"));
	assert.ok(!text.includes("ALPHA_PAGE_ONE"));
	assert.ok(!text.includes("CHARLIE_PAGE_THREE"));
	assert.equal(result.details?.pageCount, 1);
	assert.equal(result.details?.firstPage, 2);
	assert.equal(result.details?.lastPage, 2);
	assert.equal(result.details?.totalPages, 3);
});

test("requires exactly one of url or path", async () => {
	const tool = registerTool();
	await assert.rejects(
		() => tool.execute("1", {}, undefined, () => {}),
		/exactly one of url or path/,
	);
	await assert.rejects(
		() => tool.execute("2", { url: "https://example.com/a.pdf", path: FIXTURE_PATH }, undefined, () => {}),
		/exactly one of url or path/,
	);
});

// --- caching ---

test("a repeated local extraction is served from cache", async () => {
	clearPdfExtractCache();
	const tool = registerTool();
	const first = await tool.execute("1", { path: FIXTURE_PATH }, undefined, () => {});
	const second = await tool.execute("2", { path: FIXTURE_PATH }, undefined, () => {});
	assert.equal(first.details?.cached, false);
	assert.equal(second.details?.cached, true);
});

test("a different page range reuses the cached parse", async () => {
	clearPdfExtractCache();
	const tool = registerTool();
	await tool.execute("1", { path: FIXTURE_PATH }, undefined, () => {});
	const ranged = await tool.execute("2", { path: FIXTURE_PATH, pages: "3" }, undefined, () => {});
	assert.equal(ranged.details?.cached, true);
	assert.ok((ranged.content[0]?.text ?? "").includes("CHARLIE_PAGE_THREE"));
});

test("a changed modification time invalidates the local cache entry", async () => {
	clearPdfExtractCache();
	const tool = registerTool();
	const dir = await mkdtemp(join(tmpdir(), "pdf-extract-mtime-"));
	const copy = join(dir, "sample.pdf");
	await copyFile(FIXTURE_PATH, copy);

	const first = await tool.execute("1", { path: copy }, undefined, () => {});
	assert.equal(first.details?.cached, false);

	const future = new Date(Date.now() + 10_000);
	await utimes(copy, future, future);

	const second = await tool.execute("2", { path: copy }, undefined, () => {});
	assert.equal(second.details?.cached, false);
});

test("remote extraction is cached across calls", async () => {
	clearPdfExtractCache();
	const tool = registerTool();
	const stub = stubFetch(FIXTURE_BYTES);
	try {
		const url = "https://example.com/doc.pdf";
		const first = await tool.execute("1", { url }, undefined, () => {});
		const second = await tool.execute("2", { url }, undefined, () => {});
		assert.equal(stub.calls(), 1);
		assert.equal(first.details?.cached, false);
		assert.equal(second.details?.cached, true);
		assert.ok((first.content[0]?.text ?? "").includes("ALPHA_PAGE_ONE"));
	} finally {
		stub.restore();
	}
});

// --- offset windowing ---

test("offset windows the extracted text and reports continuation", async () => {
	clearPdfExtractCache();
	const tool = registerTool();
	const full = await tool.execute("1", { path: FIXTURE_PATH }, undefined, () => {});
	const totalChars = full.details?.totalChars ?? 0;
	assert.ok(totalChars > 0);

	const windowed = await tool.execute("2", { path: FIXTURE_PATH, offset: 20 }, undefined, () => {});
	assert.equal(windowed.details?.offset, 20);
	assert.equal(windowed.details?.totalChars, totalChars);
});

test("offset beyond the end reports a message instead of throwing", async () => {
	clearPdfExtractCache();
	const tool = registerTool();
	const result = await tool.execute("1", { path: FIXTURE_PATH, offset: 999_999 }, undefined, () => {});
	assert.ok((result.content[0]?.text ?? "").includes("is beyond the end of the content"));
});

test("negative and fractional offsets are clamped", async () => {
	clearPdfExtractCache();
	const tool = registerTool();
	const negative = await tool.execute("1", { path: FIXTURE_PATH, offset: -50 }, undefined, () => {});
	assert.equal(negative.details?.offset, 0);
	const fractional = await tool.execute("2", { path: FIXTURE_PATH, offset: 6.9 }, undefined, () => {});
	assert.equal(fractional.details?.offset, 6);
});

// --- rejection paths ---

test("non-PDF content is rejected by the magic-byte check", async () => {
	clearPdfExtractCache();
	const tool = registerTool();
	const stub = stubFetch("<!doctype html><html>not a pdf</html>");
	try {
		await assert.rejects(
			() => tool.execute("1", { url: "https://example.com/fake.pdf" }, undefined, () => {}),
			/not a PDF/,
		);
	} finally {
		stub.restore();
	}
});

test("oversize content-length is rejected before download", async () => {
	clearPdfExtractCache();
	const tool = registerTool();
	const stub = stubFetch(FIXTURE_BYTES, { "content-length": String(30 * 1024 * 1024) });
	try {
		await assert.rejects(
			() => tool.execute("1", { url: "https://example.com/big.pdf" }, undefined, () => {}),
			/too large/,
		);
	} finally {
		stub.restore();
	}
});

test("private and loopback URLs are rejected", async () => {
	clearPdfExtractCache();
	const tool = registerTool();
	for (const url of [
		"https://127.0.0.1/doc.pdf",
		"https://192.168.1.10/doc.pdf",
		"https://localhost/doc.pdf",
		"https://0.0.0.0/doc.pdf",
	]) {
		await assert.rejects(() => tool.execute("1", { url }, undefined, () => {}), /Invalid URL/);
	}
});

test("a file: URL passed as url is rejected", async () => {
	clearPdfExtractCache();
	const tool = registerTool();
	await assert.rejects(
		() => tool.execute("1", { url: `file://${FIXTURE_PATH}` }, undefined, () => {}),
		/Invalid URL/,
	);
});

test("a missing local file reports a clear error", async () => {
	clearPdfExtractCache();
	const tool = registerTool();
	await assert.rejects(
		() => tool.execute("1", { path: join(tmpdir(), "definitely-absent-xyz.pdf") }, undefined, () => {}),
		/no such file/,
	);
});

test("a directory is rejected as not a regular file", async () => {
	clearPdfExtractCache();
	const tool = registerTool();
	const dir = await mkdtemp(join(tmpdir(), "pdf-extract-dir-"));
	await assert.rejects(() => tool.execute("1", { path: dir }, undefined, () => {}), /Not a regular file/);
});

test("a PDF with no text layer reports that instead of returning empty text", async () => {
	clearPdfExtractCache();
	const tool = registerTool();
	// A structurally valid PDF with one page and no text-drawing operators.
	const blank = [
		"%PDF-1.4",
		"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
		"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
		"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj",
		"trailer<</Root 1 0 R>>",
	].join("\n");
	const dir = await mkdtemp(join(tmpdir(), "pdf-extract-blank-"));
	const blankPath = join(dir, "blank.pdf");
	await writeFile(blankPath, blank);

	const result = await tool.execute("1", { path: blankPath }, undefined, () => {});
	assert.ok((result.content[0]?.text ?? "").includes("No extractable text layer"));
});

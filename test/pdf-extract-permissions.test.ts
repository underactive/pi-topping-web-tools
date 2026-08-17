import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFile, mkdir, mkdtemp, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	CustomToolCallEvent,
	ExtensionAPI,
	ExtensionContext,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import pdfExtractExtension, { isInsideCwd, resolveLocalPdf } from "../src/pdf-extract.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "sample.pdf");

type ToolCallHandler = (
	event: CustomToolCallEvent,
	ctx: ExtensionContext,
) => Promise<ToolCallEventResult | undefined>;

function registerHook(): ToolCallHandler {
	let handler: ToolCallHandler | undefined;
	const fakePi = {
		registerTool: () => {},
		on: (name: string, fn: ToolCallHandler) => {
			if (name === "tool_call") handler = fn;
		},
		registerCommand: () => {},
	};
	pdfExtractExtension(fakePi as unknown as ExtensionAPI);
	if (!handler) throw new Error("tool_call hook was not registered");
	return handler;
}

function mockCtx(hasUI: boolean, choice?: string): ExtensionContext {
	return {
		hasUI,
		ui: { select: async () => choice ?? "Deny" },
	} as unknown as ExtensionContext;
}

function callEvent(input: Record<string, unknown>): CustomToolCallEvent {
	return { toolName: "pdf_extract", input } as unknown as CustomToolCallEvent;
}

// --- unrelated tools ---

test("the hook ignores other tools", async () => {
	const handler = registerHook();
	const event = { toolName: "fetch_markdown", input: { url: "https://example.com" } };
	const result = await handler(event as unknown as CustomToolCallEvent, mockCtx(true, "Deny"));
	assert.equal(result, undefined);
});

// --- remote gating ---

test("a preapproved host is allowed without prompting", async () => {
	const handler = registerHook();
	let prompted = false;
	const ctx = {
		hasUI: true,
		ui: {
			select: async () => {
				prompted = true;
				return "Deny";
			},
		},
	} as unknown as ExtensionContext;

	const result = await handler(callEvent({ url: "https://docs.python.org/3/whatsnew.pdf" }), ctx);
	assert.equal(result, undefined);
	assert.equal(prompted, false);
});

test("an unknown host prompts and blocks on deny", async () => {
	const handler = registerHook();
	const result = await handler(callEvent({ url: "https://unknown.example/doc.pdf" }), mockCtx(true, "Deny"));
	assert.equal(result?.block, true);
});

test("an unknown host is allowed once when approved", async () => {
	const handler = registerHook();
	const result = await handler(
		callEvent({ url: "https://unknown.example/doc.pdf" }),
		mockCtx(true, "Allow once"),
	);
	assert.equal(result, undefined);
});

test("allow for this session is remembered and stops prompting", async () => {
	const handler = registerHook();
	let prompts = 0;
	const ctx = {
		hasUI: true,
		ui: {
			select: async () => {
				prompts += 1;
				return "Allow for this session";
			},
		},
	} as unknown as ExtensionContext;

	assert.equal(await handler(callEvent({ url: "https://repeat.example/a.pdf" }), ctx), undefined);
	assert.equal(await handler(callEvent({ url: "https://repeat.example/b.pdf" }), ctx), undefined);
	assert.equal(prompts, 1);
});

test("deny is remembered for the rest of the session", async () => {
	const handler = registerHook();
	let prompts = 0;
	const ctx = {
		hasUI: true,
		ui: {
			select: async () => {
				prompts += 1;
				return "Deny";
			},
		},
	} as unknown as ExtensionContext;

	assert.equal((await handler(callEvent({ url: "https://denied.example/a.pdf" }), ctx))?.block, true);
	assert.equal((await handler(callEvent({ url: "https://denied.example/b.pdf" }), ctx))?.block, true);
	assert.equal(prompts, 1);
});

test("a non-preapproved host is blocked when there is no UI", async () => {
	const handler = registerHook();
	const result = await handler(callEvent({ url: "https://unknown.example/doc.pdf" }), mockCtx(false));
	assert.equal(result?.block, true);
	assert.match(String(result?.reason), /no UI for confirmation/);
});

// --- local gating ---

test("a file inside cwd is allowed without prompting", async () => {
	const handler = registerHook();
	let prompted = false;
	const ctx = {
		hasUI: true,
		ui: {
			select: async () => {
				prompted = true;
				return "Deny";
			},
		},
	} as unknown as ExtensionContext;

	const result = await handler(callEvent({ path: FIXTURE_PATH }), ctx);
	assert.equal(result, undefined);
	assert.equal(prompted, false);
});

test("a file outside cwd prompts and blocks on deny", async () => {
	const handler = registerHook();
	const dir = await mkdtemp(join(tmpdir(), "pdf-extract-outside-"));
	const outside = join(dir, "sample.pdf");
	await copyFile(FIXTURE_PATH, outside);

	const result = await handler(callEvent({ path: outside }), mockCtx(true, "Deny"));
	assert.equal(result?.block, true);
});

test("a file outside cwd is allowed when approved", async () => {
	const handler = registerHook();
	const dir = await mkdtemp(join(tmpdir(), "pdf-extract-outside-ok-"));
	const outside = join(dir, "sample.pdf");
	await copyFile(FIXTURE_PATH, outside);

	const result = await handler(callEvent({ path: outside }), mockCtx(true, "Allow once"));
	assert.equal(result, undefined);
});

test("a symlink inside cwd pointing outside still prompts", async () => {
	const handler = registerHook();
	const dir = await mkdtemp(join(tmpdir(), "pdf-extract-symlink-"));
	const target = join(dir, "target.pdf");
	await copyFile(FIXTURE_PATH, target);

	const linkDir = join(__dirname, "fixtures");
	const link = join(linkDir, "escaping-link.pdf");
	try {
		await symlink(target, link);
	} catch {
		return; // symlinks unavailable; nothing to assert
	}

	let prompted = false;
	const ctx = {
		hasUI: true,
		ui: {
			select: async () => {
				prompted = true;
				return "Deny";
			},
		},
	} as unknown as ExtensionContext;

	try {
		const result = await handler(callEvent({ path: link }), ctx);
		// realpath resolves the link out of cwd before the cwd check, so it must prompt.
		assert.equal(prompted, true);
		assert.equal(result?.block, true);
	} finally {
		await unlink(link).catch(() => {});
	}
});

test("a traversal path outside cwd prompts rather than silently allowing", async () => {
	const handler = registerHook();
	const result = await handler(callEvent({ path: "/etc/hosts" }), mockCtx(true, "Deny"));
	assert.equal(result?.block, true);
});

test("a non-regular file is blocked", async () => {
	const handler = registerHook();
	const dir = await mkdtemp(join(tmpdir(), "pdf-extract-notfile-"));
	const sub = join(dir, "subdir");
	await mkdir(sub);
	const result = await handler(callEvent({ path: sub }), mockCtx(true, "Allow once"));
	assert.equal(result?.block, true);
	assert.match(String(result?.reason), /Not a regular file/);
});

test("a missing local file is blocked at the hook", async () => {
	const handler = registerHook();
	const result = await handler(
		callEvent({ path: join(tmpdir(), "absent-file-abc.pdf") }),
		mockCtx(true, "Allow once"),
	);
	assert.equal(result?.block, true);
	assert.match(String(result?.reason), /no such file/);
});

// --- helpers ---

test("isInsideCwd distinguishes project files from outside paths", () => {
	assert.equal(isInsideCwd(FIXTURE_PATH), true);
	assert.equal(isInsideCwd("/etc/hosts"), false);
	assert.equal(isInsideCwd(process.cwd()), false);
});

test("resolveLocalPdf accepts a file:// URL and returns the real path", async () => {
	const target = await resolveLocalPdf(`file://${FIXTURE_PATH}`);
	assert.equal(target.path, FIXTURE_PATH);
	assert.ok(target.size > 0);
	assert.ok(target.mtimeMs > 0);
});

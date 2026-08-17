import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type {
	CustomToolCallEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { isGranted, DAY_MS, WEEK_MS, MONTH_MS } from "../src/permission-store.ts";
import fetchMarkdownExtension from "../src/fetch-markdown.ts";

type ToolCallHandler = (
	event: CustomToolCallEvent,
	ctx: ExtensionContext,
) => Promise<ToolCallEventResult | undefined | void>;

function extractToolCallHandler(factory: ExtensionFactory): {
	handler: ToolCallHandler;
	ctx: (hasUI: boolean, choice?: string) => ExtensionContext;
	promptCount: () => number;
} {
	let handler: ToolCallHandler | undefined;
	let prompts = 0;
	const fakePi = {
		on: (event: string, h: unknown) => {
			if (event === "tool_call") {
				handler = h as ToolCallHandler;
			}
		},
		registerTool: () => {},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	factory(fakePi);
	if (!handler) throw new Error("tool_call handler was not registered");
	const ctx = (hasUI: boolean, choice?: string): ExtensionContext =>
		({
			hasUI,
			ui: {
				select: async () => {
					prompts += 1;
					return choice ?? "Deny";
				},
			},
		}) as unknown as ExtensionContext;
	return { handler, ctx, promptCount: () => prompts };
}

function event(url: string): CustomToolCallEvent {
	return { type: "tool_call", toolCallId: "1", toolName: "fetch_markdown", input: { url } };
}

test("preapproved hosts bypass the confirmation prompt", async () => {
	const { handler, ctx, promptCount } = extractToolCallHandler(fetchMarkdownExtension);
	const result = await handler(event("https://react.dev/learn"), ctx(false));
	assert.equal(result, undefined);
	assert.equal(promptCount(), 0);
});

test("Allow once passes without caching a session decision", async () => {
	const { handler, ctx, promptCount } = extractToolCallHandler(fetchMarkdownExtension);
	const first = await handler(event("https://evil.example/once"), ctx(true, "Allow once"));
	assert.equal(first, undefined);
	const second = await handler(event("https://evil.example/once"), ctx(false));
	assert.equal(second?.block, true);
	assert.match(second?.reason ?? "", /blocked \(no UI for confirmation\)/);
	assert.equal(promptCount(), 1);
});

test("Allow for this session caches the allow decision", async () => {
	const { handler, ctx, promptCount } = extractToolCallHandler(fetchMarkdownExtension);
	const first = await handler(event("https://evil.example/session"), ctx(true, "Allow for this session"));
	assert.equal(first, undefined);
	const second = await handler(event("https://evil.example/other-path"), ctx(false));
	assert.equal(second, undefined);
	assert.equal(promptCount(), 1);
});

test("Deny caches and blocks subsequent calls", async () => {
	const { handler, ctx, promptCount } = extractToolCallHandler(fetchMarkdownExtension);
	const first = await handler(event("https://evil.example/denied"), ctx(true, "Deny"));
	assert.equal(first?.block, true);
	assert.match(first?.reason ?? "", /Denied by user for https:\/\/evil\.example/);
	const second = await handler(event("https://evil.example/denied"), ctx(true, "Allow once"));
	assert.equal(second?.block, true);
	assert.match(second?.reason ?? "", /Denied by user/);
	assert.equal(promptCount(), 1);
});

// --- Durable grant tests ---

let tempDir: string;
let originalEnv: string | undefined;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "fetch-markdown-durable-"));
	originalEnv = process.env.PI_WEB_TOOLS_PERMISSIONS_FILE;
	process.env.PI_WEB_TOOLS_PERMISSIONS_FILE = join(tempDir, "web-permissions.json");
});

afterEach(async () => {
	if (originalEnv === undefined) {
		delete process.env.PI_WEB_TOOLS_PERMISSIONS_FILE;
	} else {
		process.env.PI_WEB_TOOLS_PERMISSIONS_FILE = originalEnv;
	}
	await rm(tempDir, { recursive: true, force: true });
});

test("durable options are offered for remote hosts (select receives full list)", async () => {
	let receivedOptions: string[] = [];
	const fakePi = {
		on: (e: string, h: unknown) => {},
		registerTool: () => {},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	fetchMarkdownExtension(fakePi);
	// We need to re-extract the handler after registration.
	// Instead, use the helper but capture options.
	let handler: ToolCallHandler | undefined;
	const fakePi2 = {
		on: (e: string, h: unknown) => {
			if (e === "tool_call") handler = h as ToolCallHandler;
		},
		registerTool: () => {},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	fetchMarkdownExtension(fakePi2);
	if (!handler) throw new Error("handler not registered");

	const ctx = {
		hasUI: true,
		ui: {
			select: async (_label: string, options: string[]) => {
				receivedOptions = options;
				return "Deny";
			},
		},
	} as unknown as ExtensionContext;

	await handler(event("https://new-host.example/"), ctx);
	assert.ok(receivedOptions.includes("Allow for 1 day"));
	assert.ok(receivedOptions.includes("Allow for 1 week"));
	assert.ok(receivedOptions.includes("Allow for 30 days"));
});

test("Allow for 1 day persists a durable grant", async () => {
	const { handler, ctx } = extractToolCallHandler(fetchMarkdownExtension);
	const result = await handler(
		event("https://durable.example/"),
		ctx(true, "Allow for 1 day"),
	);
	assert.equal(result, undefined);
	assert.equal(isGranted("fetch_markdown", "https://durable.example"), true);
});

test("durable grant suppresses prompt on fresh extension instance", async () => {
	// First instance: grant.
	const first = extractToolCallHandler(fetchMarkdownExtension);
	await first.handler(event("https://persist.example/"), first.ctx(true, "Allow for 1 week"));

	// Second instance: should not prompt.
	const second = extractToolCallHandler(fetchMarkdownExtension);
	const result = await second.handler(event("https://persist.example/"), second.ctx(false));
	assert.equal(result, undefined);
	assert.equal(second.promptCount(), 0);
});

test("a fetch_markdown durable grant does not authorize web_browser", async () => {
	const { handler, ctx } = extractToolCallHandler(fetchMarkdownExtension);
	await handler(event("https://cross-scope.example/"), ctx(true, "Allow for 1 day"));

	assert.equal(isGranted("fetch_markdown", "https://cross-scope.example"), true);
	assert.equal(isGranted("web_browser", "https://cross-scope.example"), false);
	assert.equal(isGranted("pdf_extract", "https://cross-scope.example"), false);
});

test("durable grant honored with hasUI false", async () => {
	const { handler } = extractToolCallHandler(fetchMarkdownExtension);
	const grantCtx = {
		hasUI: true,
		ui: { select: async () => "Allow for 1 day" },
	} as unknown as ExtensionContext;
	await handler(event("https://headless.example/"), grantCtx);

	// Now try with no UI.
	const noUICtx = {
		hasUI: false,
		ui: { select: async () => "Deny" },
	} as unknown as ExtensionContext;
	const result = await handler(event("https://headless.example/"), noUICtx);
	assert.equal(result, undefined);
});

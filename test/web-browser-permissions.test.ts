import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { CustomToolCallEvent, ExtensionAPI, ExtensionContext, ExtensionFactory, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import {
	checkUrlPermission,
	isLocalOrPrivateHost,
	upgradeHttpToHttps,
	validateURL,
} from "../src/web-browser/permissions.ts";
import { closeBrowserManager, getBrowserManager } from "../src/web-browser/browser-manager.ts";
import fetchMarkdownExtension from "../src/fetch-markdown.ts";
import webBrowserExtension from "../src/web-browser/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "fixtures", "browser-fixture.html");

test("validateURL allows localhost and IPv6 loopback", () => {
	assert.equal(validateURL("http://localhost:3000/"), true);
	assert.equal(validateURL("http://[::1]:3000/"), true);
	assert.equal(validateURL("http://example.com/"), true);
	assert.equal(validateURL("http://foo/"), false);
	assert.equal(validateURL("http://user:pass@example.com/"), false);
});

test("validateURL edge cases", () => {
	assert.equal(validateURL(""), false);
	assert.equal(validateURL("a".repeat(2001)), false);
	assert.equal(validateURL("ftp://example.com/"), false);
	assert.equal(validateURL("file:///tmp/test.html"), true);
	assert.equal(validateURL("http://user:pass@example.com/"), false);
});

test("upgradeHttpToHttps skips local and private hosts", () => {
	assert.equal(upgradeHttpToHttps("http://localhost:3000"), "http://localhost:3000");
	assert.equal(upgradeHttpToHttps("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
	assert.equal(upgradeHttpToHttps("http://10.0.0.1/"), "http://10.0.0.1/");
	assert.equal(upgradeHttpToHttps("http://192.168.1.1/"), "http://192.168.1.1/");
	assert.equal(upgradeHttpToHttps("http://mydev.local/"), "http://mydev.local/");
	assert.equal(upgradeHttpToHttps("http://example.com/"), "https://example.com/");
	assert.equal(upgradeHttpToHttps("https://example.com/"), "https://example.com/");
});

test("isLocalOrPrivateHost localhost and loopback", () => {
	assert.equal(isLocalOrPrivateHost("localhost"), true);
	assert.equal(isLocalOrPrivateHost("::1"), true);
	assert.equal(isLocalOrPrivateHost("[::1]"), true);
	assert.equal(isLocalOrPrivateHost("127.0.0.1"), true);
	assert.equal(isLocalOrPrivateHost("127.1.2.3"), true);
});

test("isLocalOrPrivateHost .local suffix", () => {
	assert.equal(isLocalOrPrivateHost("mydev.local"), true);
	assert.equal(isLocalOrPrivateHost("host.mDNS.local"), true);
});

test("isLocalOrPrivateHost private IPv4 ranges", () => {
	assert.equal(isLocalOrPrivateHost("10.0.0.1"), true);
	assert.equal(isLocalOrPrivateHost("172.16.0.1"), true);
	assert.equal(isLocalOrPrivateHost("172.31.255.255"), true);
	assert.equal(isLocalOrPrivateHost("192.168.1.1"), true);
	assert.equal(isLocalOrPrivateHost("169.254.1.1"), true);
});

test("isLocalOrPrivateHost public IPs", () => {
	assert.equal(isLocalOrPrivateHost("8.8.8.8"), false);
	assert.equal(isLocalOrPrivateHost("1.1.1.1"), false);
});

test("isLocalOrPrivateHost rejects invalid octets", () => {
	assert.equal(isLocalOrPrivateHost("256.0.0.1"), false);
	assert.equal(isLocalOrPrivateHost("1.2.3.999"), false);
});

function mockCtx(hasUI: boolean, choice?: string): ExtensionContext {
	return {
		hasUI,
		ui: {
			select: async () => choice ?? "Deny",
		},
	} as unknown as ExtensionContext;
}

test("checkUrlPermission preapproved bypass", async () => {
	const session = new Map<string, "allow" | "deny">();
	const result = await checkUrlPermission("https://react.dev/learn", mockCtx(false), session);
	assert.equal(result, "allow");
});

test("checkUrlPermission hasUI false blocks non-preapproved", async () => {
	const session = new Map<string, "allow" | "deny">();
	const result = await checkUrlPermission("https://unknown-host.example/", mockCtx(false), session);
	assert.match(result, /^block:web_browser to https:\/\/unknown-host\.example blocked/);
});

test("checkUrlPermission allow once", async () => {
	const session = new Map<string, "allow" | "deny">();
	const result = await checkUrlPermission(
		"https://unknown-host.example/",
		mockCtx(true, "Allow once"),
		session,
	);
	assert.equal(result, "allow");
	assert.equal(session.size, 0);
});

test("checkUrlPermission allow for session", async () => {
	const session = new Map<string, "allow" | "deny">();
	const result = await checkUrlPermission(
		"https://unknown-host.example/",
		mockCtx(true, "Allow for this session"),
		session,
	);
	assert.equal(result, "allow");
	assert.equal(session.get("https://unknown-host.example"), "allow");

	const cached = await checkUrlPermission("https://unknown-host.example/page", mockCtx(false), session);
	assert.equal(cached, "allow");
});

test("checkUrlPermission deny", async () => {
	const session = new Map<string, "allow" | "deny">();
	const result = await checkUrlPermission(
		"https://unknown-host.example/",
		mockCtx(true, "Deny"),
		session,
	);
	assert.match(result, /^block:Denied by user for https:\/\/unknown-host\.example/);
	assert.equal(session.get("https://unknown-host.example"), "deny");

	const cached = await checkUrlPermission("https://unknown-host.example/", mockCtx(true, "Allow once"), session);
	assert.match(cached, /^block:Denied by user/);
});

test("checkUrlPermission file:// with session pre-approval", async () => {
	const session = new Map<string, "allow" | "deny">();
	session.set("file:///tmp/test.html", "allow");
	const result = await checkUrlPermission("file:///tmp/test.html", mockCtx(false), session);
	assert.equal(result, "allow");
});

test("checkUrlPermission file:// without pre-approval prompts", async () => {
	const session = new Map<string, "allow" | "deny">();
	const result = await checkUrlPermission(
		"file:///tmp/test.html",
		mockCtx(true, "Allow once"),
		session,
	);
	assert.equal(result, "allow");
});

type ToolCallHandler = (event: CustomToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | undefined | void>;

function extractToolCallHandler(factory: ExtensionFactory): ToolCallHandler {
	let handler: ToolCallHandler | undefined;
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
	return handler;
}

test("fetch_markdown tool_call hook blocks non-preapproved host without UI", async () => {
	const handler = extractToolCallHandler(fetchMarkdownExtension);
	const result = await handler(
		{ type: "tool_call", toolCallId: "1", toolName: "fetch_markdown", input: { url: "https://evil.example/" } },
		mockCtx(false),
	);
	assert.match(result?.reason ?? "", /fetch_markdown to evil\.example blocked/);
});

test("web_browser tool_call hook blocks navigate to non-preapproved host without UI", async () => {
	const handler = extractToolCallHandler(webBrowserExtension);
	const result = await handler(
		{
			type: "tool_call",
			toolCallId: "1",
			toolName: "web_browser",
			input: { action: "navigate", url: "https://evil.example/" },
		},
		mockCtx(false),
	);
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /evil\.example/);
});

test("web_browser tool_call hook blocks evaluate on a non-preapproved page without UI", async () => {
	const handler = extractToolCallHandler(webBrowserExtension);
	const browser = getBrowserManager();
	try {
		await browser.navigate(`file://${fixturePath}`);
		const result = await handler(
			{
				type: "tool_call",
				toolCallId: "1",
				toolName: "web_browser",
				input: { action: "evaluate", script: "location.href='https://evil.example'" },
			},
			mockCtx(false),
		);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /file:\/\//);
	} finally {
		await closeBrowserManager();
	}
});

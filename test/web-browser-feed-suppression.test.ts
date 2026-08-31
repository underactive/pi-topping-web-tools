import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import webBrowserExtension, { browserLabel } from "../src/web-browser/index.ts";
import { BROWSER_FEED_TYPE, publishBrowserState, resetBrowserFeedState } from "../src/web-browser/feeds.ts";

test("browser labels identify hosts, local files, and unavailable URLs", () => {
	assert.equal(browserLabel("https://example.com/path"), "example.com");
	assert.equal(browserLabel("file:///tmp/page.html"), "local file");
	assert.equal(browserLabel(""), "ready");
	assert.equal(browserLabel("not a URL"), "ready");
});

test("suppression hides the native browser footer while publishing feed state", async () => {
	resetBrowserFeedState();
	const previous = process.env.PI_SUPPRESS_NOTIFICATIONS;
	process.env.PI_SUPPRESS_NOTIFICATIONS = "1";
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const entries: Array<{ type: string; payload: unknown }> = [];
	const statuses: unknown[] = [];
	let tool: { execute: Function } | undefined;
	const pi = {
		appendEntry: (type: string, payload: unknown) => entries.push({ type, payload }),
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) => handlers.set(event, handler),
		registerCommand: () => {},
		registerTool: (candidate: unknown) => { tool = candidate as { execute: Function }; },
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true,
		ui: {
			setStatus: (_key: string, value: unknown) => statuses.push(value),
			notify: () => {},
			theme: { fg: (_tone: string, text: string) => text },
		},
	} as unknown as ExtensionContext;

	try {
		webBrowserExtension(pi);
		publishBrowserState("example.com", 1);
		await handlers.get("session_start")?.({}, ctx);
		assert.ok(tool);
		await tool.execute("close", { action: "close" }, undefined, () => {}, ctx);

		assert.deepEqual(statuses, []);
		assert.deepEqual(entries, [
			{ type: BROWSER_FEED_TYPE, payload: { label: "example.com", open: 1 } },
			{ type: BROWSER_FEED_TYPE, payload: { label: "", open: 0 } },
		]);
	} finally {
		if (previous === undefined) delete process.env.PI_SUPPRESS_NOTIFICATIONS;
		else process.env.PI_SUPPRESS_NOTIFICATIONS = previous;
		resetBrowserFeedState();
	}
});

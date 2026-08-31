import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	BROWSER_FEED_TYPE,
	publishBrowserState,
	registerBrowserFeeds,
	resetBrowserFeedState,
} from "../src/web-browser/feeds.ts";

function createPi(entries: Array<{ type: string; payload: unknown }>, fail = false) {
	const handlers = new Map<string, () => void>();
	return {
		appendEntry: (type: string, payload: unknown) => {
			if (fail) throw new Error("unavailable");
			entries.push({ type, payload });
		},
		on: (event: string, handler: () => void) => handlers.set(event, handler),
		emit: (event: string) => handlers.get(event)?.(),
	} as unknown as ExtensionAPI & { emit(event: string): void };
}

test("browser feed emits typed open and closed states only when changed", () => {
	resetBrowserFeedState();
	const entries: Array<{ type: string; payload: unknown }> = [];
	const pi = createPi(entries);
	registerBrowserFeeds(pi);

	publishBrowserState("example.com", 1);
	publishBrowserState("example.com", true);
	publishBrowserState("", 0);

	assert.deepEqual(entries, [
		{ type: BROWSER_FEED_TYPE, payload: { label: "example.com", open: 1 } },
		{ type: BROWSER_FEED_TYPE, payload: { label: "", open: 0 } },
	]);
});

test("browser feed retries a payload after append failure", () => {
	resetBrowserFeedState();
	const entries: Array<{ type: string; payload: unknown }> = [];
	const failingPi = createPi(entries, true);
	registerBrowserFeeds(failingPi);
	publishBrowserState("example.com", 1);

	const workingPi = createPi(entries);
	registerBrowserFeeds(workingPi);
	publishBrowserState("example.com", 1);
	assert.deepEqual(entries, [{ type: BROWSER_FEED_TYPE, payload: { label: "example.com", open: 1 } }]);
});

test("browser feed republishes the latest state after a session starts and first turn ends", () => {
	resetBrowserFeedState();
	const entries: Array<{ type: string; payload: unknown }> = [];
	const pi = createPi(entries);
	registerBrowserFeeds(pi);
	publishBrowserState("example.com", 1);

	pi.emit("session_start");
	publishBrowserState("example.com", 1);
	pi.emit("turn_end");
	pi.emit("turn_end");

	assert.deepEqual(entries, [
		{ type: BROWSER_FEED_TYPE, payload: { label: "example.com", open: 1 } },
		{ type: BROWSER_FEED_TYPE, payload: { label: "example.com", open: 1 } },
		{ type: BROWSER_FEED_TYPE, payload: { label: "example.com", open: 1 } },
	]);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	CustomToolCallEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import webBrowserExtension from "../src/web-browser/index.ts";

type ToolCallHandler = (
	event: CustomToolCallEvent,
	ctx: ExtensionContext,
) => Promise<ToolCallEventResult | undefined | void>;

function extractToolCallHandler(factory: ExtensionFactory): ToolCallHandler {
	let handler: ToolCallHandler | undefined;
	const fakePi = {
		on: (event: string, candidate: unknown) => {
			if (event === "tool_call") handler = candidate as ToolCallHandler;
		},
		registerTool: () => {},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	factory(fakePi);
	if (!handler) throw new Error("tool_call handler was not registered");
	return handler;
}

function mockCtx(): ExtensionContext {
	return { hasUI: false } as unknown as ExtensionContext;
}

test("web_browser evaluate checks the current page permission", async () => {
	const handler = extractToolCallHandler(webBrowserExtension);
	const result = await handler(
		{
			type: "tool_call",
			toolCallId: "1",
			toolName: "web_browser",
			input: { action: "evaluate", script: "1 + 1" },
		},
		mockCtx(),
	);

	assert.equal(result?.block, true);
	assert.equal(result?.reason, "Invalid URL");
});

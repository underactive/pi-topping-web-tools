import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	CustomToolCallEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
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
	assert.match(first?.reason ?? "", /Denied by user for evil\.example/);
	const second = await handler(event("https://evil.example/denied"), ctx(true, "Allow once"));
	assert.equal(second?.block, true);
	assert.match(second?.reason ?? "", /Denied by user/);
	assert.equal(promptCount(), 1);
});

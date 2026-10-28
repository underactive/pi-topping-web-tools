import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import decisionExtension, { wrapperNote } from "../src/decision/index.ts";
import { WEB_TOOLS_NAMESPACE } from "../src/tool-exposure.ts";
import { failedResult, fakeRegistry, type FakeRegistry, toolResult, withSettingsFile } from "./decision-harness.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function loadExtension() {
	const tools: ToolDefinition[] = [];
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerTool: (tool: ToolDefinition) => tools.push(tool),
		registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) =>
			commands.set(name, options),
	} as unknown as ExtensionAPI;
	decisionExtension(pi);
	const emit = async (name: string, event: unknown, ctx: unknown = {}): Promise<unknown> => {
		let result: unknown;
		for (const handler of handlers.get(name) ?? []) result = (await handler(event, ctx)) ?? result;
		return result;
	};
	return { tools, emit, commands };
}

function textOf(content: readonly { type: string }[]): string {
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

async function runChooseTool(tool: ToolDefinition, registry: FakeRegistry, params: Record<string, unknown>) {
	const ctx = { modelRegistry: registry } as unknown as Parameters<ToolDefinition["execute"]>[4];
	return tool.execute("call-1", params, undefined, undefined, ctx);
}

const fetchContent = [{ type: "text", text: '<untrusted-content url="https://app.example.com/">\n\n</untrusted-content>' }];

function fetchCall(url: string, extra: Record<string, unknown> = {}) {
	return { type: "tool_call", toolCallId: "fm-1", toolName: "fetch_markdown", input: { url, ...extra } };
}

function fetchResult() {
	return { type: "tool_result", toolCallId: "fm-1", toolName: "fetch_markdown", input: {}, content: fetchContent, isError: false };
}

test("with the gate off, no tool is registered and fetch_markdown is untouched", async () => {
	await withSettingsFile("{}", async () => {
		const { tools, emit } = loadExtension();
		assert.equal(tools.length, 0);
		const registry = fakeRegistry();
		await emit("tool_call", fetchCall("https://app.example.com/"), { modelRegistry: registry });
		assert.equal(await emit("tool_result", fetchResult()), undefined);
		assert.equal(registry.calls.length, 0);
	});
});

test("classifier-tool mode registers choose_tool with the shared exposure and namespace", async () => {
	await withSettingsFile(JSON.stringify({ toolExposure: "deferred", decision: { enabled: true } }), async () => {
		const { tools } = loadExtension();
		assert.equal(tools.length, 1);
		assert.equal(tools[0].name, "choose_tool");
		assert.equal(tools[0].exposure, "deferred");
		assert.deepEqual(tools[0].namespace, WEB_TOOLS_NAMESPACE);
		assert.deepEqual(tools[0].annotations, { readOnlyHint: true, openWorldHint: false });
	});
});

test("choose_tool returns the classifier's recommendation and the next step", async () => {
	await withSettingsFile(JSON.stringify({ decision: { enabled: true } }), async () => {
		const { tools } = loadExtension();
		const registry = fakeRegistry({ classify: async () => toolResult("web_browser", 0.9) });
		const result = await runChooseTool(tools[0], registry, { url: "https://app.example.com/", question: "chart values" });
		const text = textOf(result.content);
		assert.match(text, /^Recommended: web_browser \(classifier typesafe\/jev-latest, confidence 90%/);
		assert.match(text, /Call web_browser with this URL/);
		assert.deepEqual(registry.calls[0].context.state, { url: "https://app.example.com/", question: "chart values" });
	});
});

test("a classifier timeout leaves the choice to the agent", async () => {
	await withSettingsFile(JSON.stringify({ decision: { enabled: true } }), async () => {
		const { tools } = loadExtension();
		const registry = fakeRegistry({ classify: async () => failedResult("request timed out") });
		const text = textOf((await runChooseTool(tools[0], registry, { url: "https://example.com/" })).content);
		assert.match(text, /^No recommendation: classifier timed out/);
		assert.match(text, /Choose between fetch_markdown and web_browser from their descriptions\./);
	});
});

test("choose_tool answers without a classifier call once the gate is turned off", async () => {
	await withSettingsFile(JSON.stringify({ decision: { enabled: true } }), async (path) => {
		const { tools } = loadExtension();
		writeFileSync(path, JSON.stringify({ decision: { enabled: false } }));
		const registry = fakeRegistry();
		const text = textOf((await runChooseTool(tools[0], registry, { url: "https://example.com/" })).content);
		assert.match(text, /decision gate is disabled/);
		assert.equal(registry.calls.length, 0);
	});
});

test("wrapper mode appends a browser note to the fetch_markdown result", async () => {
	await withSettingsFile(JSON.stringify({ decision: { enabled: true, mode: "wrapper" } }), async () => {
		const { tools, emit } = loadExtension();
		assert.equal(tools.length, 0);
		const registry = fakeRegistry({ classify: async () => toolResult("web_browser", 0.75) });
		await emit("tool_call", fetchCall("https://app.example.com/", { prompt: "pricing table" }), { modelRegistry: registry });
		const changed = (await emit("tool_result", fetchResult())) as { content: { type: string }[] };
		assert.equal(changed.content.length, 2);
		assert.deepEqual(changed.content[0], fetchContent[0]);
		assert.match(textOf(changed.content.slice(1)), /^\[decision gate\] Classifier typesafe\/jev-latest .*confidence 75%.*retry with web_browser\.$/);
		assert.deepEqual(registry.calls[0].context.state, { url: "https://app.example.com/", question: "pricing table" });
	});
});

test("wrapper mode leaves the result alone when fetch_markdown was the right tool", async () => {
	await withSettingsFile(JSON.stringify({ decision: { enabled: true, mode: "wrapper" } }), async () => {
		const { emit } = loadExtension();
		const registry = fakeRegistry({ classify: async () => toolResult("fetch_markdown") });
		await emit("tool_call", fetchCall("https://docs.example.com/"), { modelRegistry: registry });
		assert.equal(await emit("tool_result", fetchResult()), undefined);
		assert.equal(registry.calls.length, 1);
	});
});

test("wrapper mode skips later windows and notes PDFs without a classifier call", async () => {
	await withSettingsFile(JSON.stringify({ decision: { enabled: true, mode: "wrapper" } }), async () => {
		const { emit } = loadExtension();
		const registry = fakeRegistry({ classify: async () => toolResult("web_browser") });
		await emit("tool_call", fetchCall("https://app.example.com/", { offset: 100_000 }), { modelRegistry: registry });
		assert.equal(await emit("tool_result", fetchResult()), undefined);

		await emit("tool_call", fetchCall("https://example.com/paper.pdf"), { modelRegistry: registry });
		const changed = (await emit("tool_result", fetchResult())) as { content: { type: string }[] };
		assert.equal(textOf(changed.content.slice(1)), "[decision gate] Use pdf_extract for this URL: the URL path ends in .pdf.");
		assert.equal(registry.calls.length, 0);
	});
});

test("wrapperNote stays silent for fetch_markdown and failures", () => {
	assert.equal(wrapperNote({ ok: false, reason: "x" }), undefined);
	assert.equal(wrapperNote({ ok: true, source: "rule", tool: "fetch_markdown", reason: "x" }), undefined);
});

test("/web-tools-settings outside the TUI points at the settings file", async () => {
	await withSettingsFile("{}", async (path) => {
		const { commands } = loadExtension();
		const notices: string[] = [];
		const ctx = { mode: "print", ui: { notify: (message: string) => notices.push(message) } } as unknown as ExtensionCommandContext;
		await commands.get("web-tools-settings")?.handler("", ctx);
		assert.equal(notices.length, 1);
		assert.ok(notices[0].includes(path));
	});
});

test("/web-tools-settings saves the menu result and registers or withdraws choose_tool", async () => {
	await withSettingsFile(JSON.stringify({ toolExposure: "codemode" }), async (path) => {
		const { tools, commands } = loadExtension();
		assert.equal(tools.length, 0);
		const registry = fakeRegistry();
		const notices: string[] = [];
		let menuValues: Record<string, unknown> = {};
		const ctx = {
			mode: "tui",
			modelRegistry: registry,
			ui: {
				notify: (message: string) => notices.push(message),
				custom: async () => ({ applied: true, action: "apply", values: menuValues }),
			},
		} as unknown as ExtensionCommandContext;
		const command = commands.get("web-tools-settings");

		menuValues = {
			enabled: true,
			mode: "classifier-tool",
			classifier: "typesafe/jev-latest",
			timeoutMs: 2000,
			circuitBreakerEnabled: true,
			circuitBreakerCooldownSeconds: 30,
		};
		await command?.handler("", ctx);
		const written = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(written.toolExposure, "codemode");
		assert.deepEqual(written.decision, {
			enabled: true,
			mode: "classifier-tool",
			provider: "typesafe",
			model: "jev-latest",
			timeoutMs: 2000,
			circuitBreakerEnabled: true,
			circuitBreakerCooldownSeconds: 30,
		});
		assert.equal(tools.length, 1);
		assert.equal(tools[0].exposure, "codemode");
		assert.match(notices.at(-1) ?? "", /Decision gate on \(choose_tool, classifier typesafe\/jev-latest\)\. Using typesafe\/jev-latest\./);

		menuValues = { ...menuValues, mode: "wrapper" };
		await command?.handler("", ctx);
		assert.equal(tools.length, 2);
		assert.equal(tools[1].name, "choose_tool");
		assert.equal(tools[1].exposure, "hidden");

		menuValues = { ...menuValues, enabled: false };
		await command?.handler("", ctx);
		assert.equal(tools.length, 2);
		assert.equal(notices.at(-1), "Decision gate off.");
	});
});

test("/web-tools-settings warns when the gate is on but no classifier has credentials", async () => {
	await withSettingsFile("{}", async () => {
		const { commands } = loadExtension();
		const notices: string[] = [];
		const ctx = {
			mode: "tui",
			modelRegistry: fakeRegistry({ configured: [] }),
			ui: {
				notify: (message: string) => notices.push(message),
				custom: async () => ({ applied: true, values: { enabled: true } }),
			},
		} as unknown as ExtensionCommandContext;
		await commands.get("web-tools-settings")?.handler("", ctx);
		assert.match(notices.at(-1) ?? "", /No classifier model has credentials/);
	});
});

import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import webBrowserExtension from "../src/web-browser/index.ts";
import { closeBrowserManager } from "../src/web-browser/browser-manager.ts";
import { resetBrowserFeedState } from "../src/web-browser/feeds.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "fixtures", "browser-fixture.html");

type WebBrowserTool = {
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: () => void,
		ctx: ExtensionContext,
	) => Promise<{ details?: Record<string, unknown> }>;
};

type ExtensionHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

async function startFixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
	const html = await readFile(fixturePath, "utf-8");
	const server: Server = createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end(html);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Failed to bind fixture server");
	}

	return {
		url: `http://127.0.0.1:${address.port}/`,
		close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
	};
}

function registerExtension(): { tool: WebBrowserTool; toolCallHandler: ExtensionHandler } {
	let tool: WebBrowserTool | undefined;
	const handlers = new Map<string, ExtensionHandler[]>();
	const pi = {
		appendEntry: () => {},
		on: (event: string, handler: ExtensionHandler) => {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		registerCommand: () => {},
		registerTool: (candidate: unknown) => {
			tool = candidate as WebBrowserTool;
		},
	} as unknown as ExtensionAPI;

	webBrowserExtension(pi);
	const toolCallHandler = handlers.get("tool_call")?.[0];
	if (!tool || !toolCallHandler) {
		throw new Error("web_browser tool or tool_call handler was not registered");
	}
	return { tool, toolCallHandler };
}

function mockCtx(): ExtensionContext {
	return {
		hasUI: true,
		ui: {
			notify: () => {},
			select: async () => "Allow for this session",
			setStatus: () => {},
			theme: { fg: (_tone: string, text: string) => text },
		},
	} as unknown as ExtensionContext;
}

function assertJsonShaped(details: unknown): asserts details is Record<string, unknown> {
	assert.ok(details && typeof details === "object" && !Array.isArray(details));
	for (const [key, value] of Object.entries(details)) {
		assert.notEqual(value, undefined, `details.${key} is undefined - not JSON-shaped`);
	}
	assert.deepEqual(JSON.parse(JSON.stringify(details)), details);
}

test("navigate details remain JSON-shaped for same-document navigation", async () => {
	resetBrowserFeedState();
	const fixture = await startFixtureServer();
	const tempDir = await mkdtemp(join(tmpdir(), "web-browser-details-json-"));
	const previousPermissionsFile = process.env.PI_WEB_TOOLS_PERMISSIONS_FILE;
	process.env.PI_WEB_TOOLS_PERMISSIONS_FILE = join(tempDir, "web-permissions.json");
	const { tool, toolCallHandler } = registerExtension();
	const ctx = mockCtx();

	try {
		const permissionResult = await toolCallHandler(
			{
				type: "tool_call",
				toolCallId: "1",
				toolName: "web_browser",
				input: { action: "navigate", url: fixture.url },
			},
			ctx,
		);
		assert.equal(permissionResult, undefined);

		const initial = await tool.execute("1", { action: "navigate", url: fixture.url }, undefined, () => {}, ctx);
		assertJsonShaped(initial.details);
		assert.equal(initial.details.statusCode, 200);

		const sameDocument = await tool.execute(
			"2",
			{ action: "navigate", url: `${fixture.url}#section` },
			undefined,
			() => {},
			ctx,
		);
		assertJsonShaped(sameDocument.details);
		assert.equal("statusCode" in sameDocument.details, false);
	} finally {
		await closeBrowserManager();
		await fixture.close();
		resetBrowserFeedState();
		if (previousPermissionsFile === undefined) delete process.env.PI_WEB_TOOLS_PERMISSIONS_FILE;
		else process.env.PI_WEB_TOOLS_PERMISSIONS_FILE = previousPermissionsFile;
		await rm(tempDir, { recursive: true, force: true });
	}
});

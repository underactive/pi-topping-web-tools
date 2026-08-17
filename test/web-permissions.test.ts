import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { addGrant, removeGrant, listGrants, DAY_MS } from "../src/permission-store.ts";
import webPermissionsExtension from "../src/web-permissions.ts";

let tempDir: string;
let originalEnv: string | undefined;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "web-permissions-test-"));
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

function registerCommand(): {
	handler: (args: string, ctx: ExtensionContext) => Promise<void>;
} {
	let handler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	const fakePi = {
		on: () => {},
		registerTool: () => {},
		registerCommand: (name: string, opts: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
			handler = opts.handler;
		},
	} as unknown as ExtensionAPI;
	webPermissionsExtension(fakePi);
	if (!handler) throw new Error("/web-permissions command was not registered");
	return { handler };
}

function mockCtx(
	opts: {
		hasUI?: boolean;
		selectChoice?: string;
		confirmResult?: boolean;
		notifications?: string[];
	} = {},
): { ctx: ExtensionContext; notifications: string[] } {
	const notifications: string[] = opts.notifications ?? [];
	const ctx = {
		hasUI: opts.hasUI ?? true,
		ui: {
			select: async () => opts.selectChoice ?? "Done",
			confirm: async () => opts.confirmResult ?? false,
			notify: (msg: string, _type?: string) => {
				notifications.push(msg);
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, notifications };
}

test("non-interactive session shows warning", async () => {
	const { handler } = registerCommand();
	const { ctx, notifications } = mockCtx({ hasUI: false });

	await handler("", ctx);
	assert.ok(notifications.some((n) => n.includes("interactive session")));
});

test("empty store shows info notification", async () => {
	const { handler } = registerCommand();
	const { ctx, notifications } = mockCtx();

	await handler("", ctx);
	assert.ok(notifications.some((n) => n.includes("No saved host permissions")));
});

test("lists grants and Done exits", async () => {
	await addGrant("fetch_markdown", "https://example.com", DAY_MS);
	await addGrant("web_browser", "https://test.com", DAY_MS);

	const { handler } = registerCommand();
	let selectCalls = 0;
	const ctx = {
		hasUI: true,
		ui: {
			select: async (_label: string, options: string[]) => {
				selectCalls++;
				return "Done";
			},
			confirm: async () => false,
			notify: () => {},
		},
	} as unknown as ExtensionContext;

	await handler("", ctx);
	assert.equal(selectCalls, 1);
});

test("selecting a grant and confirming removes it", async () => {
	await addGrant("fetch_markdown", "https://example.com", DAY_MS);

	const { handler } = registerCommand();
	const removed: string[] = [];
	let selectChoice: string | undefined;

	const ctx = {
		hasUI: true,
		ui: {
			select: async (_label: string, options: string[]) => {
				// First call: pick the grant entry. Second call: "Done".
				if (!selectChoice) {
					// Find the option that contains the origin.
					const entry = options.find((o) => o.includes("example.com"));
					selectChoice = entry;
					return entry ?? "Done";
				}
				return "Done";
			},
			confirm: async () => true,
			notify: (msg: string) => {
				removed.push(msg);
			},
		},
	} as unknown as ExtensionContext;

	await handler("", ctx);
	assert.ok(removed.some((m) => m.includes("Removed permission")));
	assert.equal(listGrants().length, 0);
});

test("selecting a grant and not confirming keeps it", async () => {
	await addGrant("fetch_markdown", "https://example.com", DAY_MS);

	const { handler } = registerCommand();
	let firstSelect = true;

	const ctx = {
		hasUI: true,
		ui: {
			select: async (_label: string, options: string[]) => {
				if (firstSelect) {
					firstSelect = false;
					return options.find((o) => o.includes("example.com")) ?? "Done";
				}
				return "Done";
			},
			confirm: async () => false,
			notify: () => {},
		},
	} as unknown as ExtensionContext;

	await handler("", ctx);
	assert.equal(listGrants().length, 1);
});

test("escape/undefined from select exits", async () => {
	await addGrant("fetch_markdown", "https://example.com", DAY_MS);

	const { handler } = registerCommand();
	const ctx = {
		hasUI: true,
		ui: {
			select: async () => undefined,
			confirm: async () => false,
			notify: () => {},
		},
	} as unknown as ExtensionContext;

	await handler("", ctx);
	// Grant should still be there.
	assert.equal(listGrants().length, 1);
});

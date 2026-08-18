import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import webBrowserExtension from "../src/web-browser/index.ts";
import {
	BrowserManager,
	closeBrowserManager,
	type PageInfo,
} from "../src/web-browser/browser-manager.ts";

type WebBrowserTool = {
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: () => void,
		ctx: ExtensionContext,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details?: { action?: string; error?: string };
		isError?: boolean;
	}>;
};

function registerTool(): WebBrowserTool {
	let tool: WebBrowserTool | undefined;
	const fakePi = {
		registerTool: (candidate: unknown) => {
			tool = candidate as WebBrowserTool;
		},
		on: () => {},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	webBrowserExtension(fakePi);
	if (!tool) throw new Error("web_browser tool was not registered");
	return tool;
}

function mockCtx(): ExtensionContext {
	return {
		hasUI: false,
		ui: {
			select: async () => "Deny",
		},
	} as unknown as ExtensionContext;
}

test("web_browser wrapUntrustedContent keeps the url attribute intact when the page URL embeds a double quote", async () => {
	const tool = registerTool();

	const originalGetText = BrowserManager.prototype.getText;
	const originalGetPageInfo = BrowserManager.prototype.getPageInfoAsync;
	BrowserManager.prototype.getText = async function () {
		return "page data";
	};
	const injectedUrl = 'https://example.com/path?q="evil';
	BrowserManager.prototype.getPageInfoAsync = async function (): Promise<PageInfo> {
		return {
			url: injectedUrl,
			title: "",
			isOpen: true,
			consoleCount: 0,
			networkCount: 0,
			dialogCount: 0,
			tabCount: 1,
		};
	};

	try {
		const result = await tool.execute(
			"1",
			{ action: "get_text" },
			undefined,
			() => {},
			mockCtx(),
		);
		const text = result.content[0]?.text ?? "";

		// A raw double quote in the page URL must be percent-encoded so it cannot
		// terminate the url attribute early and inject content outside the fence.
		assert.doesNotMatch(text, /url="https:\/\/example\.com\/path\?q="evil"/);
		assert.equal(
			text,
			'<untrusted-content url="https://example.com/path?q=%22evil">\npage data\n</untrusted-content>',
		);
	} finally {
		BrowserManager.prototype.getText = originalGetText;
		BrowserManager.prototype.getPageInfoAsync = originalGetPageInfo;
		await closeBrowserManager();
	}
});

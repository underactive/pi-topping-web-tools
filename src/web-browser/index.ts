/**
 * web_browser — headless browser automation for the pi coding agent (see ACTIONS for the full action list).
 * Commands: /browser, /browser-close, /browser-screenshot.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import {
	closeBrowserManager,
	getBrowserManager,
	type ConsoleEntry,
	type DialogEntry,
	type NavigateResult,
	type NetworkEntry,
	type ScreenshotResult,
	type SetCookieParam,
	type TabInfo,
} from "./browser-manager.ts";
import { checkUrlPermission, upgradeHttpToHttps, validateURL } from "./permissions.ts";
import { requestHostPermission } from "../permission-prompt.ts";
import { listGrants } from "../permission-store.ts";
import { isInsideCwd } from "../pdf-extract.ts";

const ACTIONS = [
	"navigate",
	"screenshot",
	"click",
	"type",
	"hover",
	"press",
	"select_option",
	"set_viewport",
	"evaluate",
	"get_content",
	"get_text",
	"get_markdown",
	"wait_for",
	"get_accessibility_snapshot",
	"get_console_logs",
	"get_network_logs",
	"get_cookies",
	"set_cookies",
	"go_back",
	"go_forward",
	"reload",
	"scroll",
	"drag",
	"upload_file",
	"set_dialog_behavior",
	"get_dialog_logs",
	"list_tabs",
	"switch_tab",
	"close",
] as const;

type WebBrowserAction = (typeof ACTIONS)[number];

interface WebBrowserDetails {
	action: WebBrowserAction;
	url?: string;
	title?: string;
	statusCode?: number;
	bytes?: number;
	screenshotDims?: string;
	consoleCount?: number;
	networkCount?: number;
	dialogCount?: number;
	tabCount?: number;
	fullOutputPath?: string;
	error?: string;
}

function formatConsoleLogs(entries: ConsoleEntry[]): string {
	if (entries.length === 0) {
		return "No console messages captured.";
	}
	return entries
		.map((e) => {
			const ts = new Date(e.timestamp).toISOString();
			return `[${ts}] ${e.type}: ${e.text}`;
		})
		.join("\n");
}

function formatNetworkLogs(entries: NetworkEntry[]): string {
	if (entries.length === 0) {
		return "No network issues captured.";
	}
	return entries
		.map((e) => {
			const ts = new Date(e.timestamp).toISOString();
			const status = e.status > 0 ? `${e.status} ${e.statusText}`.trim() : "failed";
			const failure = e.failure ? ` — ${e.failure}` : "";
			return `[${ts}] ${e.type} ${e.method} ${status} ${e.url}${failure}`;
		})
		.join("\n");
}

function formatDialogLogs(entries: DialogEntry[]): string {
	if (entries.length === 0) {
		return "No dialogs captured.";
	}
	return entries
		.map((e) => {
			const ts = new Date(e.timestamp).toISOString();
			const defaultNote = e.defaultValue ? ` (default: "${e.defaultValue}")` : "";
			return `[${ts}] ${e.type}: "${e.message}"${defaultNote} — ${e.action}ed`;
		})
		.join("\n");
}

function formatTabs(tabs: TabInfo[]): string {
	if (tabs.length === 0) {
		return "No tabs open.";
	}
	return tabs
		.map((t) => `[${t.index}]${t.active ? " (active)" : ""} ${t.title || "(untitled)"} — ${t.url}`)
		.join("\n");
}

function wrapUntrustedContent(url: string, text: string): string {
	const safeUrl = url.replaceAll('"', "%22");
	return `<untrusted-content url="${safeUrl}">\n${text}\n</untrusted-content>`;
}

function isAbortError(err: unknown): boolean {
	return err instanceof Error && (err.name === "AbortError" || err.message.includes("Aborted"));
}

function blockReason(permission: string): string {
	return permission.startsWith("block:") ? permission.slice("block:".length) : permission;
}

async function resolveLocalFilePath(input: string): Promise<string> {
	try {
		return await realpath(resolve(input));
	} catch {
		throw new Error(`Cannot upload file: no such file "${input}"`);
	}
}

async function truncateTextResult(
	text: string,
	details: WebBrowserDetails,
): Promise<{ text: string; details: WebBrowserDetails }> {
	const truncation = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	let resultText = truncation.content;
	const outDetails = { ...details, bytes: truncation.totalBytes };

	if (truncation.truncated) {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-web-browser-"));
		const tempFile = join(tempDir, "output.txt");
		await withFileMutationQueue(tempFile, async () => {
			await writeFile(tempFile, text, "utf-8");
		});

		outDetails.fullOutputPath = tempFile;

		const truncatedLines = truncation.totalLines - truncation.outputLines;
		const truncatedBytes = truncation.totalBytes - truncation.outputBytes;

		resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
		resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
		resultText += ` ${truncatedLines} lines (${formatSize(truncatedBytes)}) omitted.`;
		resultText += ` Full output saved to: ${tempFile}]`;
	}

	return { text: resultText, details: outDetails };
}

async function saveScreenshotToTempFile(shot: ScreenshotResult): Promise<string> {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-web-browser-"));
	const tempFile = join(tempDir, "screenshot.png");
	const buf = Buffer.from(shot.data, "base64");
	await withFileMutationQueue(tempFile, async () => {
		await writeFile(tempFile, buf);
	});
	return tempFile;
}

function browserStatus(ctx: ExtensionContext, text: string, tone: "success" | "muted"): string {
	return ctx.ui.theme.fg(tone, `browser: ${text}`);
}

function updateBrowserStatus(ctx: ExtensionContext, info: { url: string; title?: string }): void {
	try {
		const parsed = new URL(info.url);
		const label = parsed.protocol === "file:" ? "local file" : parsed.hostname;
		ctx.ui.setStatus("browser", browserStatus(ctx, label, "success"));
	} catch {
		ctx.ui.setStatus("browser", browserStatus(ctx, "ready", "muted"));
	}
}

export default function (pi: ExtensionAPI) {
	const sessionPermissions = new Map<string, "allow" | "deny">();

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("browser", undefined);
	});

	pi.on("session_shutdown", async () => {
		await closeBrowserManager();
		sessionPermissions.clear();
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "web_browser") return undefined;

		const input = event.input as { action?: string; url?: string };

		if (input.action === "navigate" && input.url) {
			const permission = await checkUrlPermission(input.url, ctx, sessionPermissions);
			if (permission !== "allow") {
				return { block: true, reason: blockReason(permission) };
			}

			return undefined;
		}

		if (input.action === "evaluate") {
			const info = await getBrowserManager().getPageInfoAsync();
			const permission = await checkUrlPermission(info.url, ctx, sessionPermissions);
			if (permission !== "allow") {
				return { block: true, reason: blockReason(permission) };
			}
		}

		return undefined;
	});

	pi.registerCommand("browser", {
		description:
			"Show headless browser status (open/closed, URL, title, console and network counts, session-approved hosts)",
		handler: async (_args, ctx) => {
			const browser = getBrowserManager();
			const info = await browser.getPageInfoAsync();
			const lines = [
				"Web Browser:",
				`  Status: ${info.isOpen ? "open" : "closed"}`,
				`  URL: ${info.url || "(none)"}`,
				`  Title: ${info.title?.replace(/[\u0000-\u001f\u007f]/g, " ") || "(none)"}`,
				`  Tabs open: ${info.tabCount}`,
				`  Console messages: ${info.consoleCount}`,
				`  Network issues: ${info.networkCount}`,
				`  Dialogs captured: ${info.dialogCount}`,
				`  Session-approved hosts: ${sessionPermissions.size}`,
				`  Saved hosts: ${listGrants().filter((g) => g.scope === "web_browser").length}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("browser-close", {
		description: "Force close the headless browser",
		handler: async (_args, ctx) => {
			await closeBrowserManager();
			ctx.ui.setStatus("browser", undefined);
			ctx.ui.notify("Browser closed", "info");
		},
	});

	pi.registerCommand("browser-screenshot", {
		description: "Save a full-page screenshot to a temp PNG file",
		handler: async (_args, ctx) => {
			const browser = getBrowserManager();
			const info = await browser.getPageInfoAsync();
			if (!info.isOpen) {
				ctx.ui.notify("Browser is closed — navigate to a page first.", "warning");
				return;
			}

			const shot = await browser.screenshot({ fullPage: true });
			const tempFile = await saveScreenshotToTempFile(shot);
			const dims = `${shot.width}×${shot.height}`;
			ctx.ui.notify(`Screenshot saved to: ${tempFile}\nDimensions: ${dims} (full page)`, "info");
		},
	});

	pi.registerTool({
		name: "web_browser",
		label: "Web Browser",
		promptSnippet:
			"Automate a headless browser to navigate sites, click/type, capture screenshots, evaluate JS, and read console logs.",
		promptGuidelines: [
			"Call web_browser with action navigate before interacting with a page.",
			"Use get_text for visible page text (fastest, lowest tokens); use get_markdown for structured headings/lists.",
			"Use get_accessibility_snapshot to find interactive elements with less noise than HTML.",
			"Use get_content only when DOM structure or attributes are needed; it returns raw HTML.",
			"On SPA sites, use wait_for after navigate (selector/state or networkidle) before click/type.",
			"Use screenshot for visual verification (requires a vision-capable model); use toFile=true to save PNG to disk instead of base64.",
			"Use get_console_logs when JavaScript errors or console output may explain page behavior.",
			"Use get_network_logs when failed requests or 4xx/5xx responses may explain page behavior.",
			"Use set_cookies to inject cookies for authenticated flows after manual login.",
			"Use hover to trigger tooltips/hover-menus before click; press for keyboard key events (Enter, Escape, Tab) — distinct from type mode:press which types characters; select_option to choose <select> dropdown values; set_viewport to resize the page for responsive/mobile checks.",
			"Selectors are CSS selectors, or Playwright's role= and text= selector engines (e.g. role=button[name='Submit'], text=Sign in). If click/type fails, read the returned diagnostics and page snippet and adjust the selector.",
			"Use frame to target an element inside an iframe: pass a CSS selector for the iframe itself, separate from the element selector.",
			"Call set_dialog_behavior before the action that triggers a JS dialog (alert/confirm/prompt) — dialogs are dismissed by default, which would silently cancel a confirm(). Use get_dialog_logs to see captured dialogs.",
			"Opening a link with target=_blank or window.open creates a popup that automatically becomes the active tab. Use list_tabs and switch_tab to manage multiple open tabs.",
			"Use scroll to bring an off-screen element into view (selector) or to scroll the page/container by pixel deltas; use drag for drag-and-drop between two selectors; use upload_file to set files on an <input type=file>.",
		],
		description:
			"Automate a headless Chromium browser. Actions: navigate, screenshot (toFile), click, type (mode fill|press), hover, press, select_option, set_viewport, evaluate, get_content, get_text, get_markdown, wait_for, get_accessibility_snapshot, get_console_logs, get_network_logs, get_cookies, set_cookies, go_back, go_forward, reload, scroll, drag, upload_file, set_dialog_behavior, get_dialog_logs, list_tabs, switch_tab, close. Returns page content, screenshots (PNG base64 or file path), console logs, network logs, dialog logs, tab lists, or cookie metadata (values redacted).",
		parameters: Type.Object({
			action: StringEnum(ACTIONS, {
				description: "Browser action to perform",
			}),
			url: Type.Optional(
				Type.String({
					description:
						"URL to navigate to (action: navigate). Accepts http(s), localhost/private-IP dev servers, and file:// paths.",
				}),
			),
			selector: Type.Optional(
				Type.String({
					description:
						"CSS selector, or Playwright role=/text= selector (actions: click, type, hover, select_option, screenshot, get_text, wait_for, get_accessibility_snapshot, scroll, upload_file). For drag, this is the source selector.",
				}),
			),
			frame: Type.Optional(
				Type.String({
					description:
						"CSS selector for an iframe to scope the element selector into (actions: click, type, hover, select_option, screenshot, get_text, wait_for, get_accessibility_snapshot, scroll, upload_file, drag)",
				}),
			),
			targetSelector: Type.Optional(
				Type.String({ description: "Target CSS selector to drop onto (action: drag)" }),
			),
			files: Type.Optional(
				Type.Array(Type.String(), {
					description: "Absolute file paths to upload (action: upload_file)",
				}),
			),
			deltaX: Type.Optional(
				Type.Number({ description: "Horizontal scroll delta in pixels (action: scroll, default 0)" }),
			),
			deltaY: Type.Optional(
				Type.Number({
					description: "Vertical scroll delta in pixels (action: scroll, default: viewport height)",
				}),
			),
			index: Type.Optional(
				Type.Number({ description: "Tab index to switch to, from list_tabs (action: switch_tab)" }),
			),
			dialogAction: Type.Optional(
				StringEnum(["accept", "dismiss"], {
					description:
						"How to resolve future JS dialogs (alert/confirm/prompt) for the rest of the session (action: set_dialog_behavior, default dismiss)",
				}),
			),
			promptText: Type.Optional(
				Type.String({
					description: "Text to enter when accepting a prompt() dialog (action: set_dialog_behavior)",
				}),
			),
			text: Type.Optional(
				Type.String({ description: "Text to type into selector (action: type)" }),
			),
			key: Type.Optional(
				Type.String({ description: "Keyboard key to press (action: press, e.g. Enter, Escape, Tab)" }),
			),
			values: Type.Optional(
				Type.String({
					description:
						"Comma-separated option values to select (action: select_option, e.g. option1,option2)",
				}),
			),
			width: Type.Optional(
				Type.Number({ description: "Viewport width in pixels (action: set_viewport)" }),
			),
			height: Type.Optional(
				Type.Number({ description: "Viewport height in pixels (action: set_viewport)" }),
			),
			mode: Type.Optional(
				StringEnum(["fill", "press"], {
					description:
						"Typing mode (action: type, default fill). fill clears the field first; press types key-by-key and appends to existing input.",
				}),
			),
			state: Type.Optional(
				StringEnum(["visible", "hidden", "attached", "detached"], {
					description: "Wait state (action: wait_for, default visible)",
				}),
			),
			networkidle: Type.Optional(
				Type.Boolean({ description: "Wait for network idle (action: wait_for)" }),
			),
			script: Type.Optional(
				Type.String({ description: "JavaScript expression to evaluate (action: evaluate)" }),
			),
			fullPage: Type.Optional(
				Type.Boolean({ description: "Capture full scrollable page (action: screenshot, default false)" }),
			),
			toFile: Type.Optional(
				Type.Boolean({
					description:
						"Write screenshot PNG to a temp file and return the path instead of a base64 image (action: screenshot, default false)",
				}),
			),
			cookies: Type.Optional(
				Type.Array(
					Type.Object({
						name: Type.String(),
						value: Type.String(),
						url: Type.Optional(Type.String()),
						domain: Type.Optional(Type.String()),
						path: Type.Optional(Type.String()),
						httpOnly: Type.Optional(Type.Boolean()),
						secure: Type.Optional(Type.Boolean()),
						sameSite: Type.Optional(StringEnum(["Strict", "Lax", "None"])),
					}),
					{ description: "Cookies to set (action: set_cookies); each needs url or domain+path" },
				),
			),
			timeout: Type.Optional(
				Type.Number({ description: "Timeout in milliseconds for navigation/interaction (default 30000)" }),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const action = params.action as WebBrowserAction;
			const timeout = params.timeout;

			onUpdate?.({ content: [{ type: "text", text: `${action}…` }], details: { action } });

			try {
				if (action === "close") {
					await closeBrowserManager();
					ctx.ui.setStatus("browser", undefined);
					return {
						content: [{ type: "text", text: "Browser closed." }],
						details: { action } satisfies WebBrowserDetails,
					};
				}

				const mgr = getBrowserManager();

				switch (action) {
					case "navigate": {
						if (!params.url) {
							return {
								content: [{ type: "text", text: "url is required for navigate." }],
								details: { action, error: "missing url" },
								isError: true,
							};
						}
						if (!validateURL(params.url)) {
							return {
								content: [{ type: "text", text: "Invalid URL." }],
								details: { action, error: "invalid url" },
								isError: true,
							};
						}

						const upgraded = upgradeHttpToHttps(params.url);
						const result: NavigateResult = await mgr.navigate(upgraded, { timeout, signal });
						updateBrowserStatus(ctx, result);

						const text = `Navigated to ${result.url}\nTitle: ${result.title}${result.statusCode ? `\nStatus: ${result.statusCode}` : ""}`;
						return {
							content: [{ type: "text", text }],
							details: {
								action,
								url: result.url,
								title: result.title,
								statusCode: result.statusCode,
								bytes: Buffer.byteLength(text),
							} satisfies WebBrowserDetails,
						};
					}

					case "screenshot": {
						const shot: ScreenshotResult = await mgr.screenshot({
							fullPage: params.fullPage,
							selector: params.selector,
							frame: params.frame,
							timeout,
							signal,
						});
						const info = await mgr.getPageInfoAsync();
						updateBrowserStatus(ctx, info);
						const dims = `${shot.width}×${shot.height}`;
						const dimsNote = `${dims}${shot.fullPage ? " (full page)" : ""}`;

						if (params.toFile) {
							const tempFile = await saveScreenshotToTempFile(shot);
							const text = `Screenshot saved to: ${tempFile}\nDimensions: ${dimsNote}`;
							return {
								content: [{ type: "text", text }],
								details: {
									action,
									url: info.url,
									title: info.title,
									screenshotDims: dims,
									fullOutputPath: tempFile,
								} satisfies WebBrowserDetails,
							};
						}

						return {
							content: [
								{
									type: "image",
									data: shot.data,
									mimeType: "image/png",
								},
								{
									type: "text",
									text: `Screenshot ${dimsNote}`,
								},
							],
							details: {
								action,
								url: info.url,
								title: info.title,
								screenshotDims: dims,
							} satisfies WebBrowserDetails,
						};
					}

					case "click": {
						if (!params.selector) {
							return {
								content: [{ type: "text", text: "selector is required for click." }],
								details: { action, error: "missing selector" },
								isError: true,
							};
						}
						const msg = await mgr.click(params.selector, { timeout, signal, frame: params.frame });
						return {
							content: [{ type: "text", text: msg }],
							details: { action, bytes: Buffer.byteLength(msg) } satisfies WebBrowserDetails,
							isError: msg.startsWith("No element"),
						};
					}

					case "type": {
						if (!params.selector || params.text === undefined) {
							return {
								content: [{ type: "text", text: "selector and text are required for type." }],
								details: { action, error: "missing selector or text" },
								isError: true,
							};
						}
						const msg = await mgr.fill(params.selector, params.text, {
							timeout,
							signal,
							mode: params.mode as "fill" | "press" | undefined,
							frame: params.frame,
						});
						return {
							content: [{ type: "text", text: msg }],
							details: { action, bytes: Buffer.byteLength(msg) } satisfies WebBrowserDetails,
							isError: msg.startsWith("No element"),
						};
					}

					case "hover": {
						if (!params.selector) {
							return {
								content: [{ type: "text", text: "selector is required for hover." }],
								details: { action, error: "missing selector" },
								isError: true,
							};
						}
						const msg = await mgr.hover(params.selector, { timeout, signal, frame: params.frame });
						return {
							content: [{ type: "text", text: msg }],
							details: { action, bytes: Buffer.byteLength(msg) } satisfies WebBrowserDetails,
							isError: msg.startsWith("No element"),
						};
					}

					case "press": {
						if (!params.key) {
							return {
								content: [{ type: "text", text: "key is required for press." }],
								details: { action, error: "missing key" },
								isError: true,
							};
						}
						const msg = await mgr.press(params.key, { timeout, signal });
						return {
							content: [{ type: "text", text: msg }],
							details: { action, bytes: Buffer.byteLength(msg) } satisfies WebBrowserDetails,
						};
					}

					case "select_option": {
						if (!params.selector || !params.values) {
							return {
								content: [{ type: "text", text: "selector and values are required for select_option." }],
								details: { action, error: "missing selector or values" },
								isError: true,
							};
						}
						const values = params.values.split(",").map((v) => v.trim()).filter(Boolean);
						const msg = await mgr.selectOption(params.selector, values, { timeout, signal, frame: params.frame });
						return {
							content: [{ type: "text", text: msg }],
							details: { action, bytes: Buffer.byteLength(msg) } satisfies WebBrowserDetails,
							isError: msg.startsWith("No element"),
						};
					}

					case "set_viewport": {
						if (params.width === undefined || params.height === undefined) {
							return {
								content: [{ type: "text", text: "width and height are required for set_viewport." }],
								details: { action, error: "missing width or height" },
								isError: true,
							};
						}
						const msg = await mgr.setViewport(params.width, params.height, { signal });
						return {
							content: [{ type: "text", text: msg }],
							details: { action, bytes: Buffer.byteLength(msg) } satisfies WebBrowserDetails,
						};
					}

					case "evaluate": {
						if (!params.script) {
							return {
								content: [{ type: "text", text: "script is required for evaluate." }],
								details: { action, error: "missing script" },
								isError: true,
							};
						}
						const value = await mgr.evaluate(params.script, { signal });
						const text = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value);
						const truncated = await truncateTextResult(text, { action });
						const info = await mgr.getPageInfoAsync();
						return {
							content: [{ type: "text", text: wrapUntrustedContent(info.url, truncated.text) }],
							details: truncated.details,
						};
					}

					case "get_content": {
						const html = await mgr.content({ signal });
						const truncated = await truncateTextResult(html, { action });
						const info = await mgr.getPageInfoAsync();
						return {
							content: [{ type: "text", text: wrapUntrustedContent(info.url, truncated.text) }],
							details: truncated.details,
						};
					}

					case "get_text": {
						const text = await mgr.getText(params.selector, { timeout, signal, frame: params.frame });
						const truncated = await truncateTextResult(text, { action });
						const info = await mgr.getPageInfoAsync();
						return {
							content: [{ type: "text", text: wrapUntrustedContent(info.url, truncated.text) }],
							details: truncated.details,
						};
					}

					case "get_markdown": {
						const md = await mgr.getMarkdown({ timeout, signal });
						const truncated = await truncateTextResult(md, { action });
						const info = await mgr.getPageInfoAsync();
						return {
							content: [{ type: "text", text: wrapUntrustedContent(info.url, truncated.text) }],
							details: truncated.details,
						};
					}

					case "wait_for": {
						if (!params.selector && !params.networkidle) {
							return {
								content: [{ type: "text", text: "selector or networkidle is required for wait_for." }],
								details: { action, error: "missing selector or networkidle" },
								isError: true,
							};
						}
						const msg = await mgr.waitFor({
							selector: params.selector,
							state: params.state as "visible" | "hidden" | "attached" | "detached" | undefined,
							networkidle: params.networkidle,
							timeout,
							signal,
							frame: params.frame,
						});
						return {
							content: [{ type: "text", text: msg }],
							details: { action, bytes: Buffer.byteLength(msg) } satisfies WebBrowserDetails,
							isError: msg.startsWith("No element"),
						};
					}

					case "get_accessibility_snapshot": {
						const snapshot = await mgr.getAccessibilitySnapshot({
							selector: params.selector,
							timeout,
							signal,
							frame: params.frame,
						});
						const truncated = await truncateTextResult(snapshot, { action });
						const info = await mgr.getPageInfoAsync();
						return {
							content: [{ type: "text", text: wrapUntrustedContent(info.url, truncated.text) }],
							details: truncated.details,
						};
					}

					case "get_console_logs": {
						const entries = mgr.drainConsole();
						const text = formatConsoleLogs(entries);
						const truncated = await truncateTextResult(text, {
							action,
							consoleCount: entries.length,
						});
						const info = await mgr.getPageInfoAsync();
						return {
							content: [{ type: "text", text: wrapUntrustedContent(info.url, truncated.text) }],
							details: truncated.details,
						};
					}

					case "get_network_logs": {
						const entries = mgr.drainNetwork();
						const text = formatNetworkLogs(entries);
						const truncated = await truncateTextResult(text, {
							action,
							networkCount: entries.length,
						});
						const info = await mgr.getPageInfoAsync();
						return {
							content: [{ type: "text", text: wrapUntrustedContent(info.url, truncated.text) }],
							details: truncated.details,
						};
					}

					case "get_cookies": {
						const cookies = await mgr.getCookies({ signal });
						const redacted = cookies.map(({ name, domain, path, expires, httpOnly, secure, sameSite }) => ({
							name,
							domain,
							path,
							expires,
							httpOnly,
							secure,
							sameSite,
							value: "[redacted]",
						}));
						const text = JSON.stringify(redacted, null, 2);
						const truncated = await truncateTextResult(text, { action });
						return {
							content: [{ type: "text", text: truncated.text }],
							details: truncated.details,
						};
					}

					case "set_cookies": {
						if (!params.cookies || params.cookies.length === 0) {
							return {
								content: [{ type: "text", text: "cookies is required for set_cookies." }],
								details: { action, error: "missing cookies" },
								isError: true,
							};
						}
						for (const cookie of params.cookies) {
							const cookieUrl = cookie.url ?? `https://${cookie.domain}${cookie.path ?? "/"}`;
							const permission = await checkUrlPermission(cookieUrl, ctx, sessionPermissions);
							if (permission !== "allow") {
								return {
									content: [{ type: "text", text: blockReason(permission) }],
									details: { action, error: blockReason(permission) } satisfies WebBrowserDetails,
									isError: true,
								};
							}
						}
						await mgr.setCookies(params.cookies as SetCookieParam[], { signal });
						const text = `Set ${params.cookies.length} cookie(s).`;
						return {
							content: [{ type: "text", text }],
							details: { action, bytes: Buffer.byteLength(text) } satisfies WebBrowserDetails,
						};
					}

					case "go_back": {
						const text = await mgr.goBack({ signal });
						return {
							content: [{ type: "text", text }],
							details: { action, bytes: Buffer.byteLength(text) } satisfies WebBrowserDetails,
						};
					}

					case "go_forward": {
						const text = await mgr.goForward({ signal });
						return {
							content: [{ type: "text", text }],
							details: { action, bytes: Buffer.byteLength(text) } satisfies WebBrowserDetails,
						};
					}

					case "reload": {
						const text = await mgr.reload({ signal });
						return {
							content: [{ type: "text", text }],
							details: { action, bytes: Buffer.byteLength(text) } satisfies WebBrowserDetails,
						};
					}

					case "scroll": {
						const msg = await mgr.scroll({
							selector: params.selector,
							frame: params.frame,
							deltaX: params.deltaX,
							deltaY: params.deltaY,
							timeout,
							signal,
						});
						return {
							content: [{ type: "text", text: msg }],
							details: { action, bytes: Buffer.byteLength(msg) } satisfies WebBrowserDetails,
							isError: msg.startsWith("No element"),
						};
					}

					case "drag": {
						if (!params.selector || !params.targetSelector) {
							return {
								content: [{ type: "text", text: "selector and targetSelector are required for drag." }],
								details: { action, error: "missing selector or targetSelector" },
								isError: true,
							};
						}
						const msg = await mgr.drag(params.selector, params.targetSelector, {
							frame: params.frame,
							timeout,
							signal,
						});
						return {
							content: [{ type: "text", text: msg }],
							details: { action, bytes: Buffer.byteLength(msg) } satisfies WebBrowserDetails,
							isError: msg.startsWith("No element"),
						};
					}

					case "upload_file": {
						if (!params.selector || !params.files || params.files.length === 0) {
							return {
								content: [{ type: "text", text: "selector and files are required for upload_file." }],
								details: { action, error: "missing selector or files" },
								isError: true,
							};
						}
						for (const file of params.files) {
							const resolved = await resolveLocalFilePath(file);
							if (isInsideCwd(resolved)) continue;
							const permission = await requestHostPermission(ctx, {
								scope: "web_browser",
								label: `Allow web_browser to upload local file ${resolved}?`,
								key: `file://${resolved}`,
								sessionPermissions,
								durable: false,
							});
							if (!permission.allowed) {
								return {
									content: [{ type: "text", text: permission.reason }],
									details: { action, error: permission.reason } satisfies WebBrowserDetails,
									isError: true,
								};
							}
						}
						const msg = await mgr.uploadFile(params.selector, params.files, {
							frame: params.frame,
							timeout,
							signal,
						});
						return {
							content: [{ type: "text", text: msg }],
							details: { action, bytes: Buffer.byteLength(msg) } satisfies WebBrowserDetails,
							isError: msg.startsWith("No element"),
						};
					}

					case "set_dialog_behavior": {
						const dialogAction = (params.dialogAction as "accept" | "dismiss" | undefined) ?? "dismiss";
						mgr.setDialogBehavior(dialogAction, params.promptText);
						const text = `Dialogs will be ${dialogAction}ed${params.promptText ? ` (prompt text: "${params.promptText}")` : ""}.`;
						return {
							content: [{ type: "text", text }],
							details: { action, bytes: Buffer.byteLength(text) } satisfies WebBrowserDetails,
						};
					}

					case "get_dialog_logs": {
						const entries = mgr.drainDialogs();
						const text = formatDialogLogs(entries);
						const truncated = await truncateTextResult(text, {
							action,
							dialogCount: entries.length,
						});
						const info = await mgr.getPageInfoAsync();
						return {
							content: [{ type: "text", text: wrapUntrustedContent(info.url, truncated.text) }],
							details: truncated.details,
						};
					}

					case "list_tabs": {
						const tabs = await mgr.listTabs();
						const text = formatTabs(tabs);
						return {
							content: [{ type: "text", text }],
							details: {
								action,
								tabCount: tabs.length,
								bytes: Buffer.byteLength(text),
							} satisfies WebBrowserDetails,
						};
					}

					case "switch_tab": {
						if (params.index === undefined) {
							return {
								content: [{ type: "text", text: "index is required for switch_tab." }],
								details: { action, error: "missing index" },
								isError: true,
							};
						}
						const msg = await mgr.switchTab(params.index);
						const info = await mgr.getPageInfoAsync();
						updateBrowserStatus(ctx, info);
						return {
							content: [{ type: "text", text: msg }],
							details: { action, bytes: Buffer.byteLength(msg) } satisfies WebBrowserDetails,
							isError: msg.startsWith("Invalid tab index"),
						};
					}

					default: {
						return {
							content: [{ type: "text", text: `Unknown action: ${action}` }],
							details: { action, error: "unknown action" },
							isError: true,
						};
					}
				}
			} catch (err: unknown) {
				if (isAbortError(err)) {
					return {
						content: [{ type: "text", text: "Operation aborted." }],
						details: { action, error: "aborted" } satisfies WebBrowserDetails,
						isError: true,
					};
				}
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Browser error: ${message}` }],
					details: { action, error: message } satisfies WebBrowserDetails,
					isError: true,
				};
			}
		},

		renderCall(args, theme) {
			const action = String(args.action ?? "?");
			let text = theme.fg("toolTitle", theme.bold("web_browser "));
			text += theme.fg("accent", action);

			if (args.url) {
				try {
					const parsed = new URL(String(args.url));
					text += theme.fg("muted", ` ${parsed.hostname}`);
				} catch {
					text += theme.fg("muted", ` ${String(args.url).slice(0, 40)}`);
				}
			} else if (args.selector) {
				text += theme.fg("muted", ` ${String(args.selector)}`);
			}

			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = (result.details ?? {}) as WebBrowserDetails;

			if (isPartial) {
				return new Text(theme.fg("warning", `${details.action ?? "web_browser"}…`), 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", details.error.slice(0, 120)), 0, 0);
			}

			const imageBlock = result.content.find((c) => c.type === "image");
			if (imageBlock?.type === "image") {
				const dims = details.screenshotDims ?? "screenshot";
				return new Text(theme.fg("success", `Screenshot ${dims}`), 0, 0);
			}

			if (details.action === "screenshot" && details.fullOutputPath) {
				let text = theme.fg("success", "Screenshot saved to disk");
				if (expanded) {
					text += `\n${theme.fg("dim", `Full: ${details.fullOutputPath}`)}`;
				}
				return new Text(text, 0, 0);
			}

			let text = "";
			switch (details.action) {
				case "navigate":
					text = theme.fg(
						"success",
						`Navigated — ${details.title?.replace(/[\u0000-\u001f\u007f]/g, " ") ?? details.url ?? "ok"}`,
					);
					break;
				case "get_content":
				case "get_text":
				case "get_markdown":
				case "get_accessibility_snapshot":
					text = theme.fg("success", details.bytes ? formatSize(details.bytes) : "Content");
					break;
				case "get_console_logs":
					text = theme.fg("success", `${details.consoleCount ?? 0} console message(s)`);
					break;
				case "get_network_logs":
					text = theme.fg("success", `${details.networkCount ?? 0} network issue(s)`);
					break;
				case "get_dialog_logs":
					text = theme.fg("success", `${details.dialogCount ?? 0} dialog(s)`);
					break;
				case "list_tabs":
					text = theme.fg("success", `${details.tabCount ?? 0} tab(s)`);
					break;
				default:
					text = theme.fg("success", details.action ?? "done");
					if (details.bytes) text += theme.fg("muted", ` (${formatSize(details.bytes)})`);
			}

			if (details.fullOutputPath) {
				text += theme.fg("warning", " (truncated)");
			}

			if (expanded) {
				const content = result.content.find((c) => c.type === "text");
				if (content?.type === "text") {
					const lines = content.text.split("\n", 16);
					for (const line of lines.slice(0, 15)) {
						text += `\n${theme.fg("dim", line)}`;
					}
					if (lines.length > 15) {
						text += `\n${theme.fg("muted", "…")}`;
					}
				}
				if (details.fullOutputPath) {
					text += `\n${theme.fg("dim", `Full: ${details.fullOutputPath}`)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});
}

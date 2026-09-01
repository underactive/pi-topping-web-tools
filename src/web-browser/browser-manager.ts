/**
 * Session-scoped Playwright browser manager.
 *
 * Lazily launches a single headless Chromium instance. `context.pages()` is
 * the source of truth for open tabs; `this.page` is only an "active tab"
 * cursor. Popups claim it only after an approved main-frame navigation.
 * Page interactions are serialized via an async mutex.
 */

import type {
	APIResponse,
	Browser,
	BrowserContext,
	Cookie,
	Locator,
	Page,
	Response,
	Route,
	WebSocketRoute,
} from "playwright";
import { chromium } from "playwright";
import { getTurndownService } from "../fetch-markdown.ts";
import { permissionKey } from "../permissions.ts";
import { decideRequest, type UrlPermissionChecker } from "./egress-policy.ts";

export const DEFAULT_VIEWPORT_WIDTH = 1280;
export const DEFAULT_VIEWPORT_HEIGHT = 720;
export const MAX_FULL_PAGE_WIDTH = 1920;
export const MAX_BUFFER_ENTRIES = 500;
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const MAX_REDIRECT_HOPS = 20;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

type AbortableOpts = { timeout?: number; signal?: AbortSignal };
type FrameOpts = { frame?: string };

function parsePngDimensions(buffer: Buffer): { width: number; height: number } | undefined {
	if (buffer.length < 24) return undefined;
	if (buffer[0] !== 0x89 || buffer[1] !== 0x50) return undefined;
	return {
		width: buffer.readUInt32BE(16),
		height: buffer.readUInt32BE(20),
	};
}

export type ConsoleEntry = {
	type: "log" | "error" | "pageerror";
	text: string;
	timestamp: number;
};

export type NetworkEntry = {
	type: "failed" | "error_response";
	url: string;
	method: string;
	status: number;
	statusText: string;
	failure?: string;
	timestamp: number;
};

export type DialogEntry = {
	type: string;
	message: string;
	defaultValue: string;
	action: "accept" | "dismiss";
	timestamp: number;
};

export type TabInfo = {
	index: number;
	url: string;
	title: string;
	active: boolean;
};

export type DialogBehavior = {
	action: "accept" | "dismiss";
	promptText?: string;
};

export type SetCookieParam = {
	name: string;
	value: string;
	url?: string;
	domain?: string;
	path?: string;
	expires?: number;
	httpOnly?: boolean;
	secure?: boolean;
	sameSite?: "Strict" | "Lax" | "None";
};

export type PageInfo = {
	url: string;
	title: string;
	isOpen: boolean;
	consoleCount: number;
	networkCount: number;
	dialogCount: number;
	tabCount: number;
};

export type NavigateResult = {
	url: string;
	title: string;
	statusCode?: number;
};

export type ScreenshotResult = {
	data: string;
	width: number;
	height: number;
	fullPage: boolean;
};

export class AsyncMutex {
	private chain: Promise<void> = Promise.resolve();

	/** Wait for the operation queue to drain (no in-flight operations). */
	async drain(): Promise<void> {
		await this.chain;
	}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		let release!: () => void;
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});

		const run = this.chain.then(fn);
		this.chain = run.then(() => wait, () => wait);

		try {
			return await run;
		} finally {
			release();
		}
	}
}

export class BrowserManager {
	private browser: Browser | undefined;
	private context: BrowserContext | undefined;
	private page: Page | undefined;
	private consoleBuffer: ConsoleEntry[] = [];
	private networkBuffer: NetworkEntry[] = [];
	private dialogBuffer: DialogEntry[] = [];
	private dialogBehavior: DialogBehavior = { action: "dismiss" };
	private originChecker: UrlPermissionChecker = () => false;
	private lastBlockedDocumentUrl: string | undefined;
	private navigationPage: Page | undefined;
	private navigationSignal: AbortSignal | undefined;
	private readonly pendingRedirects = new WeakMap<Page, string>();
	private readonly mutex = new AsyncMutex();
	private closed = false; // true only after explicit close(), not on initial/normal state

	get isOpen(): boolean {
		return !this.closed && !!this.page;
	}

	async getPageInfoAsync(): Promise<PageInfo> {
		return this.mutex.run(async () => {
			if (!this.isOpen) {
				return {
					url: "",
					title: "",
					isOpen: false,
					consoleCount: this.consoleBuffer.length,
					networkCount: this.networkBuffer.length,
					dialogCount: this.dialogBuffer.length,
					tabCount: 0,
				};
			}

			const page = this.page!;
			let title = "";
			try {
				title = await page.title();
			} catch {
				// fall back to empty title
			}

			return {
				url: page.url(),
				title,
				isOpen: true,
				consoleCount: this.consoleBuffer.length,
				networkCount: this.networkBuffer.length,
				dialogCount: this.dialogBuffer.length,
				tabCount: this.context?.pages().filter((p) => !p.isClosed()).length ?? 1,
			};
		});
	}

	async launch(): Promise<void> {
		return this.mutex.run(async () => {
			await this.ensureLaunched();
		});
	}

	async navigate(url: string, opts?: AbortableOpts): Promise<NavigateResult> {
		return this.mutex.run(async () => {
			await this.ensureLaunched();
			const page = this.page!;
			const timeout = opts?.timeout ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
			this.lastBlockedDocumentUrl = undefined;
			this.navigationPage = page;
			this.navigationSignal = opts?.signal;

			let currentUrl = url;
			try {
				for (let redirects = 0; redirects <= MAX_REDIRECT_HOPS; redirects++) {
					this.pendingRedirects.delete(page);
					let response: Response | null;
					try {
						response = await this.withAbort(opts?.signal, async () =>
							page.goto(currentUrl, {
								timeout,
								waitUntil: "domcontentloaded",
							}),
						);
					} catch (err) {
						if (opts?.signal?.aborted) throw err;
						const redirectTarget = this.pendingRedirects.get(page);
						if (redirectTarget) {
							currentUrl = redirectTarget;
							continue;
						}
						const blockedError = this.blockedNavigationError(url);
						if (blockedError) throw blockedError;
						throw err;
					}

					const redirectTarget = this.pendingRedirects.get(page);
					if (redirectTarget) {
						currentUrl = redirectTarget;
						continue;
					}

					const blockedError = this.blockedNavigationError(url);
					if (blockedError) throw blockedError;
					return {
						url: page.url(),
						title: await page.title(),
						statusCode: response?.status(),
					};
				}
				throw new Error(`Blocked: more than ${MAX_REDIRECT_HOPS} redirects`);
			} finally {
				if (this.navigationPage === page) {
					this.navigationPage = undefined;
					this.navigationSignal = undefined;
				}
				this.pendingRedirects.delete(page);
			}
		});
	}

	async screenshot(
		opts?: AbortableOpts &
			FrameOpts & {
				fullPage?: boolean;
				selector?: string;
			},
	): Promise<ScreenshotResult> {
		return this.mutex.run(async () => {
			await this.ensureLaunched();
			const page = this.page!;
			const fullPage = opts?.fullPage ?? false;
			const timeout = opts?.timeout ?? DEFAULT_NAVIGATION_TIMEOUT_MS;

			const originalViewport = page.viewportSize();
			const needsResize =
				fullPage &&
				(!originalViewport ||
					originalViewport.width !== DEFAULT_VIEWPORT_WIDTH ||
					originalViewport.height !== DEFAULT_VIEWPORT_HEIGHT);
			if (needsResize) {
				await page.setViewportSize({ width: DEFAULT_VIEWPORT_WIDTH, height: DEFAULT_VIEWPORT_HEIGHT });
			}

			const buffer = await this.withAbort(opts?.signal, async () => {
				if (opts?.selector) {
					const locator = this.resolveLocator(page, opts.selector, opts.frame).first();
					await locator.waitFor({ state: "visible", timeout });
					return locator.screenshot({ type: "png", timeout });
				}
				return page.screenshot({
					type: "png",
					fullPage,
					timeout,
				});
			});

			const viewport = page.viewportSize() ?? {
				width: DEFAULT_VIEWPORT_WIDTH,
				height: DEFAULT_VIEWPORT_HEIGHT,
			};

			let width: number;
			let height: number;
			if (fullPage && !opts?.selector) {
				const dims = parsePngDimensions(buffer);
				if (dims) {
					width = dims.width > MAX_FULL_PAGE_WIDTH ? MAX_FULL_PAGE_WIDTH : dims.width;
					height = dims.height;
				} else {
					width = Math.min(viewport.width, MAX_FULL_PAGE_WIDTH);
					height = viewport.height;
				}
			} else {
				width = viewport.width;
				height = viewport.height;
			}

			if (needsResize && originalViewport) {
				await page.setViewportSize(originalViewport);
			}

			return {
				data: buffer.toString("base64"),
				width,
				height,
				fullPage,
			};
		});
	}

	async click(selector: string, opts?: AbortableOpts & FrameOpts): Promise<string> {
		return this.mutex.run(async () => {
			await this.ensureLaunched();
			const page = this.page!;
			const timeout = opts?.timeout ?? DEFAULT_NAVIGATION_TIMEOUT_MS;

			const locator = this.resolveLocator(page, selector, opts?.frame);
			try {
				await this.withAbort(opts?.signal, async () => locator.first().click({ timeout }));
			} catch (err) {
				if ((await locator.count()) === 0) {
					return await this.selectorError(page, selector, opts?.frame);
				}
				throw err;
			}
			return `Clicked "${selector}"`;
		});
	}

	async fill(
		selector: string,
		text: string,
		opts?: AbortableOpts & FrameOpts & { mode?: "fill" | "press"; delay?: number },
	): Promise<string> {
		return this.mutex.run(async () => {
			await this.ensureLaunched();
			const page = this.page!;
			const timeout = opts?.timeout ?? DEFAULT_NAVIGATION_TIMEOUT_MS;

			const locator = this.resolveLocator(page, selector, opts?.frame);
			const target = locator.first();
			try {
				await this.withAbort(opts?.signal, async () => {
					if (opts?.mode === "press") {
						await target.pressSequentially(text, { timeout, delay: opts?.delay ?? 50 });
					} else {
						await target.fill(text, { timeout });
					}
				});
			} catch (err) {
				if ((await locator.count()) === 0) {
					return await this.selectorError(page, selector, opts?.frame);
				}
				throw err;
			}
			return `Typed into "${selector}"`;
		});
	}

	async hover(selector: string, opts?: AbortableOpts & FrameOpts): Promise<string> {
		return this.mutex.run(async () => {
			await this.ensureLaunched();
			const page = this.page!;
			const timeout = opts?.timeout ?? DEFAULT_NAVIGATION_TIMEOUT_MS;

			const locator = this.resolveLocator(page, selector, opts?.frame);
			try {
				await this.withAbort(opts?.signal, async () => locator.first().hover({ timeout }));
			} catch (err) {
				if ((await locator.count()) === 0) {
					return await this.selectorError(page, selector, opts?.frame);
				}
				throw err;
			}
			return `Hovered "${selector}"`;
		});
	}

	async press(key: string, opts?: AbortableOpts): Promise<string> {
		return this.mutex.run(async () => {
			await this.ensureLaunched();
			const page = this.page!;

			await this.withAbort(opts?.signal, async () => page.keyboard.press(key));
			return `Pressed "${key}"`;
		});
	}

	async selectOption(
		selector: string,
		values: string[],
		opts?: AbortableOpts & FrameOpts,
	): Promise<string> {
		return this.mutex.run(async () => {
			await this.ensureLaunched();
			const page = this.page!;
			const timeout = opts?.timeout ?? DEFAULT_NAVIGATION_TIMEOUT_MS;

			const locator = this.resolveLocator(page, selector, opts?.frame);
			try {
				await this.withAbort(opts?.signal, async () =>
					locator.first().selectOption(values, { timeout }),
				);
			} catch (err) {
				if ((await locator.count()) === 0) {
					return await this.selectorError(page, selector, opts?.frame);
				}
				throw err;
			}
			return `Selected ${values.join(", ")} in "${selector}"`;
		});
	}

	async setViewport(width: number, height: number, opts?: AbortableOpts): Promise<string> {
		return this.mutex.run(async () => {
			await this.ensureLaunched();
			const page = this.page!;

			await this.withAbort(opts?.signal, async () => page.setViewportSize({ width, height }));
			return `Viewport set to ${width}×${height}`;
		});
	}

	async getText(selector?: string, opts?: AbortableOpts & FrameOpts): Promise<string> {
		return this.mutex.run(async () => {
			await this.ensureLaunched();
			const page = this.page!;
			const timeout = opts?.timeout ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
			const locator = this.resolveLocator(page, selector ?? "body", opts?.frame).first();
			return this.withAbort(opts?.signal, async () => locator.innerText({ timeout }));
		});
	}

	async getMarkdown(opts?: AbortableOpts): Promise<string> {
		return this.mutex.run(async () => {
			await this.ensureLaunched();
			const page = this.page!;
			const timeout = opts?.timeout ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
			await this.withAbort(opts?.signal, async () => {
				await page.waitForLoadState("domcontentloaded", { timeout });
			});
			const html = await page.evaluate(() => document.body.innerHTML);
			const svc = getTurndownService();
			return svc.turndown(html);
		});
	}

	async getAccessibilitySnapshot(
		opts?: AbortableOpts & FrameOpts & { selector?: string },
	): Promise<string> {
		return this.mutex.run(async () => {
			await this.ensureLaunched();
			const page = this.page!;
			const timeout = opts?.timeout ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
			const selector = opts?.selector ?? "body";
			const locator = this.resolveLocator(page, selector, opts?.frame);
			try {
				const snapshot = await this.withAbort(opts?.signal, async () =>
					locator.first().ariaSnapshot({ timeout }),
				);
				if (!snapshot) {
					return "No accessibility snapshot available.";
				}
				return snapshot;
			} catch (err) {
				if ((await locator.count()) === 0) {
					return await this.selectorError(page, selector, opts?.frame);
				}
				throw err;
			}
		});
	}

	async waitFor(
		opts: AbortableOpts &
			FrameOpts & {
				selector?: string;
				state?: "visible" | "hidden" | "attached" | "detached";
				networkidle?: boolean;
			},
	): Promise<string> {
		return this.mutex.run(async () => {
			await this.ensureLaunched();
			const page = this.page!;
			const timeout = opts.timeout ?? DEFAULT_NAVIGATION_TIMEOUT_MS;

			if (opts.selector) {
				const locator = this.resolveLocator(page, opts.selector, opts.frame);
				try {
					await this.withAbort(opts.signal, async () =>
						locator.first().waitFor({ state: opts.state ?? "visible", timeout }),
					);
				} catch (err) {
					if ((await locator.count()) === 0) {
						return await this.selectorError(page, opts.selector, opts.frame);
					}
					throw err;
				}
			}

			if (opts.networkidle) {
				await this.withAbort(opts.signal, async () =>
					page.waitForLoadState("networkidle", { timeout }),
				);
			}

			const parts: string[] = [];
			if (opts.selector) {
				parts.push(`selector "${opts.selector}" is ${opts.state ?? "visible"}`);
			}
			if (opts.networkidle) {
				parts.push("network idle");
			}
			return `Wait satisfied: ${parts.join(", ")}`;
		});
	}

	async scroll(
		opts?: AbortableOpts & FrameOpts & { selector?: string; deltaX?: number; deltaY?: number },
	): Promise<string> {
		return this.mutex.run(async () => {
			await this.ensureLaunched();
			const page = this.page!;
			const timeout = opts?.timeout ?? DEFAULT_NAVIGATION_TIMEOUT_MS;

			if (opts?.selector) {
				const locator = this.resolveLocator(page, opts.selector, opts.frame);
				try {
					await this.withAbort(opts.signal, async () =>
						locator.first().scrollIntoViewIfNeeded({ timeout }),
					);
				} catch (err) {
					if ((await locator.count()) === 0) {
						return await this.selectorError(page, opts.selector, opts.frame);
					}
					throw err;
				}
				return `Scrolled "${opts.selector}" into view`;
			}

			const viewport = page.viewportSize() ?? {
				width: DEFAULT_VIEWPORT_WIDTH,
				height: DEFAULT_VIEWPORT_HEIGHT,
			};
			const deltaX = opts?.deltaX ?? 0;
			const deltaY = opts?.deltaY ?? viewport.height;
			await this.withAbort(opts?.signal, async () => page.mouse.wheel(deltaX, deltaY));
			return `Scrolled by (${deltaX}, ${deltaY})`;
		});
	}

	async uploadFile(
		selector: string,
		files: string[],
		opts?: AbortableOpts & FrameOpts,
	): Promise<string> {
		return this.mutex.run(async () => {
			await this.ensureLaunched();
			const page = this.page!;
			const timeout = opts?.timeout ?? DEFAULT_NAVIGATION_TIMEOUT_MS;

			const locator = this.resolveLocator(page, selector, opts?.frame);
			try {
				await this.withAbort(opts?.signal, async () =>
					locator.first().setInputFiles(files, { timeout }),
				);
			} catch (err) {
				if ((await locator.count()) === 0) {
					return await this.selectorError(page, selector, opts?.frame);
				}
				throw err;
			}
			return `Uploaded ${files.length} file(s) to "${selector}"`;
		});
	}

	async drag(
		sourceSelector: string,
		targetSelector: string,
		opts?: AbortableOpts & FrameOpts,
	): Promise<string> {
		return this.mutex.run(async () => {
			await this.ensureLaunched();
			const page = this.page!;
			const timeout = opts?.timeout ?? DEFAULT_NAVIGATION_TIMEOUT_MS;

			const sourceLocator = this.resolveLocator(page, sourceSelector, opts?.frame);
			const targetLocator = this.resolveLocator(page, targetSelector, opts?.frame);
			try {
				await this.withAbort(opts?.signal, async () =>
					sourceLocator.first().dragTo(targetLocator.first(), { timeout }),
				);
			} catch (err) {
				if ((await sourceLocator.count()) === 0) {
					return await this.selectorError(page, sourceSelector, opts?.frame);
				}
				if ((await targetLocator.count()) === 0) {
					return await this.selectorError(page, targetSelector, opts?.frame);
				}
				throw err;
			}
			return `Dragged "${sourceSelector}" to "${targetSelector}"`;
		});
	}

	async listTabs(): Promise<TabInfo[]> {
		return this.mutex.run(async () => {
			await this.ensureLaunched();
			const pages = this.context!.pages().filter((p) => !p.isClosed());
			const titles = await Promise.all(pages.map((p) => p.title().catch(() => "")));
			return pages.map((p, i) => ({
				index: i,
				url: p.url(),
				title: titles[i]!,
				active: p === this.page,
			}));
		});
	}

	async switchTab(index: number): Promise<string> {
		return this.mutex.run(async () => {
			await this.ensureLaunched();
			const pages = this.context!.pages().filter((p) => !p.isClosed());
			if (index < 0 || index >= pages.length) {
				return `Invalid tab index ${index}. ${pages.length} tab(s) open (0–${Math.max(0, pages.length - 1)}).`;
			}
			this.page = pages[index];
			await this.page!.bringToFront();
			return `Switched to tab ${index}: ${this.page!.url()}`;
		});
	}

	setOriginChecker(checker: UrlPermissionChecker): void {
		this.originChecker = checker;
	}

	setDialogBehavior(action: "accept" | "dismiss", promptText?: string): void {
		this.dialogBehavior = { action, promptText };
	}

	drainDialogs(): DialogEntry[] {
		const entries = [...this.dialogBuffer];
		this.dialogBuffer = [];
		return entries;
	}

	async evaluate(expression: string, opts?: { signal?: AbortSignal }): Promise<unknown> {
		return this.mutex.run(async () => {
			await this.ensureLaunched();
			const page = this.page!;
			return this.withAbort(opts?.signal, async () => page.evaluate(expression));
		});
	}

	async content(opts?: { signal?: AbortSignal }): Promise<string> {
		return this.mutex.run(async () => {
			await this.ensureLaunched();
			return this.withAbort(opts?.signal, async () => this.page!.content());
		});
	}

	async getCookies(opts?: { signal?: AbortSignal }): Promise<Cookie[]> {
		return this.mutex.run(async () => {
			await this.ensureLaunched();
			return this.withAbort(opts?.signal, async () => this.context!.cookies());
		});
	}

	async setCookies(cookies: SetCookieParam[], opts?: { signal?: AbortSignal }): Promise<void> {
		return this.mutex.run(async () => {
			await this.ensureLaunched();
			await this.withAbort(opts?.signal, async () => this.context!.addCookies(cookies));
		});
	}

	drainConsole(): ConsoleEntry[] {
		const entries = [...this.consoleBuffer];
		this.consoleBuffer = [];
		return entries;
	}

	drainNetwork(): NetworkEntry[] {
		const entries = [...this.networkBuffer];
		this.networkBuffer = [];
		return entries;
	}

	async goBack(opts?: AbortableOpts): Promise<string> {
		return this.mutex.run(async () => {
			await this.ensureLaunched();
			const response = await this.withAbort(opts?.signal, async () =>
				this.page!.goBack({ waitUntil: "domcontentloaded" }),
			);
			return response ? `Navigated back to ${this.page!.url()}` : "No history to go back";
		});
	}

	async goForward(opts?: AbortableOpts): Promise<string> {
		return this.mutex.run(async () => {
			await this.ensureLaunched();
			const response = await this.withAbort(opts?.signal, async () =>
				this.page!.goForward({ waitUntil: "domcontentloaded" }),
			);
			return response ? `Navigated forward to ${this.page!.url()}` : "No history to go forward";
		});
	}

	async reload(opts?: AbortableOpts): Promise<string> {
		return this.mutex.run(async () => {
			await this.ensureLaunched();
			await this.withAbort(opts?.signal, async () =>
				this.page!.reload({ waitUntil: "domcontentloaded" }),
			);
			return `Reloaded ${this.page!.url()}`;
		});
	}

	/**
	 * Close the browser, bypassing the mutex so shutdown is never blocked
	 * by queued or in-flight operations.
	 *
	 * This is critical for `/reload` compatibility: the Pi runtime awaits all
	 * `session_shutdown` handlers synchronously. If this hangs, reload hangs.
	 *
	 * @param timeoutMs — max ms to wait for Chromium processes to exit
	 *                    (default 5000). Set to 0 for unbounded.
	 */
	async close(timeoutMs = 5_000): Promise<void> {
		// Mark closed immediately so ensureLaunched() bails out.
		this.closed = true;

		// Drain the mutex chain (wait for any in-flight operation to finish),
		// then call cleanup directly — bypassing the mutex so no new
		// operation can re-trigger ensureLaunched() mid-shutdown.
		await this.mutex.drain();

		// Force-close with optional timeout.
		await this.forceClose(timeoutMs);
	}

	/**
	 * Force-close the browser, bypassing all serialization.
	 *
	 * If a timeout is provided and cleanup doesn't complete within it,
	 * resources are left dangling (the OS will clean up the process) rather
	 * than blocking indefinitely.
	 */
	private async forceClose(timeoutMs: number): Promise<void> {
		let timerId: ReturnType<typeof setTimeout> | undefined;
		const timer =
			timeoutMs > 0
				? new Promise<never>((_, reject) => {
						timerId = setTimeout(
							() => reject(new Error("Close timed out")),
							timeoutMs,
						);
						if (typeof timerId.unref === "function") timerId.unref();
				  })
				: Promise.resolve();

		try {
			await Promise.race([this.cleanup(), timer]);
		} catch {
			// Timeout or cleanup error — best effort; resources are cleaned up by OS.
		} finally {
			if (timerId) {
				clearTimeout(timerId);
			}
		}
	}

	private async withAbort<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
		if (signal?.aborted) {
			throw new DOMException("Aborted", "AbortError");
		}
		if (!signal) {
			return fn();
		}

		const op = fn();
		op.catch(() => {});

		let listener: (() => void) | undefined;
		const abortPromise = new Promise<never>((_, reject) => {
			listener = () => reject(new DOMException("Aborted", "AbortError"));
			signal.addEventListener("abort", listener, { once: true });
		});

		try {
			return await Promise.race([op, abortPromise]);
		} finally {
			if (listener) {
				signal.removeEventListener("abort", listener);
			}
		}
	}

	private resolveLocator(page: Page, selector: string, frame?: string): Locator {
		if (frame) {
			return page.frameLocator(frame).locator(selector);
		}
		return page.locator(selector);
	}

	private async selectorDiagnostics(page: Page, selector: string, frame?: string): Promise<string> {
		try {
			if (frame) {
				const count = await page.frameLocator(frame).locator(selector).count();
				return `Matches: ${count} (within frame "${frame}")`;
			}

			return await page.evaluate((sel) => {
				const elements = Array.from(document.querySelectorAll(sel));
				const total = elements.length;
				if (total === 0) {
					return "Matches: 0";
				}

				let visible = 0;
				let hidden = 0;
				for (const el of elements) {
					const htmlEl = el as HTMLElement;
					const style = window.getComputedStyle(htmlEl);
					const isVisible = htmlEl.offsetHeight > 0 && style.visibility !== "hidden";
					if (isVisible) {
						visible++;
					} else {
						hidden++;
					}
				}

				const samples = elements.slice(0, 5).map((el) => {
					const htmlEl = el as HTMLElement;
					const text = (htmlEl.textContent ?? "").trim().slice(0, 40);
					return `<${el.tagName.toLowerCase()}>${text ? ` "${text}"` : ""}`;
				});

				return `Matches: ${total} (${visible} visible, ${hidden} hidden). Samples: ${samples.join(", ")}`;
			}, selector);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return `Diagnostics unavailable (${message})`;
		}
	}

	private async selectorError(page: Page, selector: string, frame?: string): Promise<string> {
		const diagnostics = await this.selectorDiagnostics(page, selector, frame);
		const snippet = await this.pageSnippet(page);
		const frameNote = frame ? ` within frame "${frame}"` : "";
		const safeUrl = page.url().replaceAll('"', "%22");
		return `No element matches selector "${selector}"${frameNote}. ${diagnostics}\nPage snippet:\n<untrusted-content url="${safeUrl}">\n${snippet.replaceAll("</untrusted-content", "")}\n</untrusted-content>`;
	}

	private async ensureLaunched(): Promise<void> {
		if (this.page && !this.page.isClosed() && this.browser?.isConnected()) {
			return;
		}

		// The active tab closed (e.g. a popup was dismissed) but the browser
		// and context are still alive — fall back to another open tab
		// instead of tearing down and relaunching.
		if (this.browser?.isConnected() && this.context) {
			const openPages = this.context.pages().filter((p) => !p.isClosed());
			if (openPages.length > 0) {
				this.page = openPages[openPages.length - 1];
				return;
			}
		}

		await this.cleanup();

		// Short-circuit: don't re-launch after close().
		if (this.closed) {
			return;
		}

		try {
			this.browser = await chromium.launch({ headless: true });
			this.context = await this.browser.newContext({
				viewport: {
					width: DEFAULT_VIEWPORT_WIDTH,
					height: DEFAULT_VIEWPORT_HEIGHT,
				},
				acceptDownloads: false,
				serviceWorkers: "block",
			});
			await this.context.route("**/*", (route) => this.enforceEgress(route));
			await this.context.routeWebSocket("**/*", (webSocket) =>
				this.enforceWebSocketEgress(webSocket),
			);
			this.context.on("page", (page) => this.registerPage(page));
			this.page = await this.context.newPage();
			this.closed = false;
		} catch (err: unknown) {
			await this.cleanup();
			const message = err instanceof Error ? err.message : String(err);
			if (message.includes("Executable doesn't exist") || message.includes("browserType.launch")) {
				throw new Error(
					"Chromium is not installed. Run: npx playwright install chromium",
				);
			}
			throw err;
		}
	}

	/**
	 * Attaches listeners to every page in the context. The initial page is
	 * active immediately; popups become active only after an approved main-
	 * frame navigation commits.
	 */
	private registerPage(page: Page): void {
		this.attachConsoleListeners(page);
		this.attachDialogListener(page);

		let pendingActivation = this.page !== undefined && !this.page.isClosed();
		if (!pendingActivation) {
			this.page = page;
		}

		page.on("framenavigated", (frame) => {
			if (frame !== page.mainFrame()) return;
			this.handleMainFrameNavigation(page, frame.url(), pendingActivation)
				.then((activate) => {
					if (activate && pendingActivation && !page.isClosed()) {
						this.page = page;
						pendingActivation = false;
					}
				})
				.catch(() => {
					this.closeBlockedPage(page).catch(() => {});
				});
		});

		// The context-level page event can arrive after the first navigation has
		// committed, in which case no later framenavigated event will activate it.
		const currentUrl = page.url();
		if (
			pendingActivation &&
			currentUrl !== "about:blank" &&
			decideRequest(currentUrl, "document", currentUrl, this.originChecker).allow
		) {
			this.page = page;
			pendingActivation = false;
		}
	}

	private async enforceEgress(route: Route): Promise<void> {
		const request = route.request();
		let requestPage: Page | undefined;
		let pageUrl = "";
		let isMainFrameRequest = false;
		try {
			const frame = request.frame();
			requestPage = frame.page();
			pageUrl = requestPage.url();
			isMainFrameRequest = frame === requestPage.mainFrame();
		} catch {
			// Requests without an issuing page are evaluated with an empty page URL.
		}

		const decision = decideRequest(
			request.url(),
			request.resourceType(),
			pageUrl,
			this.originChecker,
		);
		if (decision.allow) {
			const protocol = new URL(request.url()).protocol;
			if (protocol !== "http:" && protocol !== "https:") {
				await route.continue();
				return;
			}

			// route.continue() follows redirect hops without routing them again.
			// Fetch one response without redirects so Location can be approved
			// before Chromium receives a response that would contact the target.
			let response: APIResponse;
			try {
				response = await route.fetch({
					maxRedirects: 0,
					signal: requestPage === this.navigationPage ? this.navigationSignal : undefined,
				});
			} catch {
				try {
					await route.abort(this.navigationSignal?.aborted ? "aborted" : "failed");
				} catch {
					// The request may already be gone after a page or context closes.
				}
				return;
			}
			const location = REDIRECT_STATUS_CODES.has(response.status())
				? response.headers().location
				: undefined;
			if (!location) {
				try {
					await route.fulfill({ response });
				} finally {
					await response.dispose();
				}
				return;
			}

			let redirectUrl: string;
			try {
				redirectUrl = new URL(location, request.url()).toString();
			} catch {
				await response.dispose();
				this.pushNetwork({
					type: "failed",
					url: request.url(),
					method: request.method(),
					status: 0,
					statusText: "",
					failure: "blocked by egress policy: Invalid redirect URL",
					timestamp: Date.now(),
				});
				await route.abort("blockedbyclient");
				return;
			}

			const redirectDecision = decideRequest(
				redirectUrl,
				request.resourceType(),
				pageUrl,
				this.originChecker,
			);
			await response.dispose();

			if (!redirectDecision.allow) {
				if (isMainFrameRequest && requestPage === this.navigationPage) {
					this.lastBlockedDocumentUrl = redirectUrl;
				}
				this.pushNetwork({
					type: "failed",
					url: redirectUrl,
					method: request.method(),
					status: 0,
					statusText: "",
					failure: `blocked by egress policy: ${redirectDecision.reason}`,
					timestamp: Date.now(),
				});
				await route.abort("blockedbyclient");
				if (isMainFrameRequest && requestPage && requestPage !== this.page) {
					await this.closeBlockedPage(requestPage);
				}
				return;
			}

			if (request.resourceType() !== "document" || !isMainFrameRequest || !requestPage) {
				this.pushNetwork({
					type: "failed",
					url: redirectUrl,
					method: request.method(),
					status: 0,
					statusText: "",
					failure: "blocked by egress policy: Redirected subrequests are not followed",
					timestamp: Date.now(),
				});
				await route.abort("blockedbyclient");
				return;
			}

			this.pendingRedirects.set(requestPage, redirectUrl);
			await route.fulfill({
				status: 200,
				contentType: "text/html",
				body: "<!doctype html><meta charset=\"utf-8\"><title>Redirecting</title>",
			});
			if (requestPage !== this.navigationPage) {
				setTimeout(() => {
					if (requestPage.isClosed()) return;
					this.pendingRedirects.delete(requestPage);
					requestPage.goto(redirectUrl, { waitUntil: "domcontentloaded" }).catch(() => {
						if (requestPage !== this.page) this.closeBlockedPage(requestPage).catch(() => {});
					});
				}, 0);
			}
			return;
		}

		if (
			request.resourceType() === "document" &&
			isMainFrameRequest &&
			requestPage === this.page
		) {
			this.lastBlockedDocumentUrl = request.url();
		}
		this.pushNetwork({
			type: "failed",
			url: request.url(),
			method: request.method(),
			status: 0,
			statusText: "",
			failure: `blocked by egress policy: ${decision.reason}`,
			timestamp: Date.now(),
		});

		await route.abort("blockedbyclient");
		if (request.resourceType() === "document" && requestPage && requestPage !== this.page) {
			await this.closeBlockedPage(requestPage);
		}
	}

	private blockedNavigationError(requestedUrl: string): Error | undefined {
		if (!this.lastBlockedDocumentUrl) return undefined;
		const blockedTarget = permissionKey(this.lastBlockedDocumentUrl);
		const navigationType = blockedTarget === permissionKey(requestedUrl) ? "navigation" : "redirect";
		return new Error(`Blocked: ${navigationType} to ${blockedTarget} requires approval`);
	}

	private async enforceWebSocketEgress(webSocket: WebSocketRoute): Promise<void> {
		const url = webSocket.url();
		let permitted = false;
		try {
			permitted = this.originChecker(url);
		} catch {
			// Fail closed when the live permission source cannot be read.
		}

		if (permitted) {
			webSocket.connectToServer();
			return;
		}

		this.pushNetwork({
			type: "failed",
			url,
			method: "GET",
			status: 0,
			statusText: "",
			failure: "blocked by egress policy: WebSocket URL is not approved",
			timestamp: Date.now(),
		});
		await webSocket.close({ code: 1008, reason: "blocked by egress policy" });
	}

	private async handleMainFrameNavigation(
		page: Page,
		url: string,
		pendingActivation: boolean,
	): Promise<boolean> {
		if (pendingActivation && url === "about:blank") return false;
		if (
			url === "chrome-error://chromewebdata/" &&
			(page === this.navigationPage || this.pendingRedirects.has(page))
		) {
			return false;
		}

		const decision = decideRequest(url, "document", url, this.originChecker);
		if (decision.allow) return pendingActivation;

		this.pushNetwork({
			type: "failed",
			url,
			method: "GET",
			status: 0,
			statusText: "",
			failure: `blocked by egress policy: ${decision.reason}`,
			timestamp: Date.now(),
		});

		if (pendingActivation) {
			await this.closeBlockedPage(page);
			return false;
		}

		try {
			await page.goBack({ waitUntil: "commit" });
		} catch {
			// Fall through and close a page that cannot return to an approved URL.
		}

		if (!page.isClosed()) {
			const current = decideRequest(page.url(), "document", page.url(), this.originChecker);
			if (!current.allow) await this.closeBlockedPage(page);
		}
		return false;
	}

	private async closeBlockedPage(page: Page): Promise<void> {
		try {
			await page.close({ runBeforeUnload: false });
		} catch {
			// The page may already have closed while its request was being aborted.
		}

		if (this.page === page) {
			const fallback = this.context?.pages().filter((candidate) => !candidate.isClosed()).at(-1);
			this.page = fallback;
		}
	}

	private attachConsoleListeners(page: Page): void {
		page.on("console", (msg) => {
			this.pushConsole({ type: "log", text: `[${msg.type()}] ${msg.text()}`, timestamp: Date.now() });
		});
		page.on("pageerror", (err) => {
			this.pushConsole({ type: "pageerror", text: err.message, timestamp: Date.now() });
		});
		page.on("requestfailed", (req) => {
			const failure = req.failure()?.errorText ?? "unknown";
			if (failure.includes("ERR_BLOCKED_BY_CLIENT")) return;
			this.pushNetwork({
				type: "failed",
				url: req.url(),
				method: req.method(),
				status: 0,
				statusText: "",
				failure,
				timestamp: Date.now(),
			});
		});
		page.on("response", (res) => {
			const status = res.status();
			if (status >= 400) {
				this.pushNetwork({
					type: "error_response",
					url: res.url(),
					method: res.request().method(),
					status,
					statusText: res.statusText(),
					timestamp: Date.now(),
				});
			}
		});
	}

	private attachDialogListener(page: Page): void {
		page.on("dialog", (dialog) => {
			const entry: DialogEntry = {
				type: dialog.type(),
				message: dialog.message(),
				defaultValue: dialog.defaultValue(),
				action: this.dialogBehavior.action,
				timestamp: Date.now(),
			};
			this.pushDialog(entry);

			const resolve =
				this.dialogBehavior.action === "accept"
					? dialog.accept(this.dialogBehavior.promptText)
					: dialog.dismiss();
			resolve.catch(() => {
				// dialog may already have been handled/closed
			});
		});
	}

	private pushConsole(entry: ConsoleEntry): void {
		this.consoleBuffer.push(entry);
		if (this.consoleBuffer.length >= MAX_BUFFER_ENTRIES) {
			this.consoleBuffer = this.consoleBuffer.slice(MAX_BUFFER_ENTRIES >> 1);
		}
	}

	private pushNetwork(entry: NetworkEntry): void {
		this.networkBuffer.push(entry);
		if (this.networkBuffer.length >= MAX_BUFFER_ENTRIES) {
			this.networkBuffer = this.networkBuffer.slice(MAX_BUFFER_ENTRIES >> 1);
		}
	}

	private pushDialog(entry: DialogEntry): void {
		this.dialogBuffer.push(entry);
		if (this.dialogBuffer.length >= MAX_BUFFER_ENTRIES) {
			this.dialogBuffer = this.dialogBuffer.slice(MAX_BUFFER_ENTRIES >> 1);
		}
	}

	private async pageSnippet(page: Page): Promise<string> {
		return page.evaluate(() => document.documentElement.outerHTML.slice(0, 2000));
	}

	private async cleanup(): Promise<void> {
		this.consoleBuffer = [];
		this.networkBuffer = [];
		this.dialogBuffer = [];
		this.lastBlockedDocumentUrl = undefined;

		try {
			await this.context?.unrouteAll({ behavior: "ignoreErrors" });
		} catch {
			// ignore
		}
		try {
			await this.page?.close({ runBeforeUnload: false });
		} catch {
			// ignore
		}
		try {
			await this.context?.close();
		} catch {
			// ignore
		}
		try {
			await this.browser?.close();
		} catch {
			// ignore
		}

		this.page = undefined;
		this.context = undefined;
		this.browser = undefined;
		// NOTE: Do NOT set `this.closed` here — only the public `close()`
		// method should mark the manager as closed, so that `ensureLaunched()`
		// can distinguish between "initial/normal cleanup" and "post-shutdown".
		// NOTE: `dialogBehavior` is intentionally NOT reset — it is a session
		// setting, not page state.
	}
}

let manager: BrowserManager | undefined;

export function getBrowserManager(): BrowserManager {
	return (manager ??= new BrowserManager());
}

export async function closeBrowserManager(): Promise<void> {
	if (manager) {
		await manager.close();
		manager = undefined;
	}
}

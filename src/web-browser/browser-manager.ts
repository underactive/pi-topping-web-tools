/**
 * Session-scoped Playwright browser manager.
 *
 * Lazily launches a single headless Chromium instance. `context.pages()` is
 * the source of truth for open tabs; `this.page` is only an "active tab"
 * cursor that new pages (including popups) claim automatically. Page
 * interactions are serialized via an async mutex.
 */

import type { Browser, BrowserContext, Cookie, Locator, Page } from "playwright";
import { chromium } from "playwright";
import { getTurndownService } from "../fetch-markdown.ts";

export const DEFAULT_VIEWPORT_WIDTH = 1280;
export const DEFAULT_VIEWPORT_HEIGHT = 720;
export const MAX_FULL_PAGE_WIDTH = 1920;
export const MAX_BUFFER_ENTRIES = 500;
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;

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

			const response = await this.withAbort(opts?.signal, async () =>
				page.goto(url, {
					timeout,
					waitUntil: "domcontentloaded",
				}),
			);

			return {
				url: page.url(),
				title: await page.title(),
				statusCode: response?.status(),
			};
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
			});
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
	 * Attaches console/network/dialog listeners to every page in the context
	 * (including the initial page and popups) and claims it as the active
	 * tab. This is the single attachment point — `context.on("page")` also
	 * fires for `context.newPage()`, so listeners must not be attached
	 * anywhere else or they would be registered twice.
	 */
	private registerPage(page: Page): void {
		this.attachConsoleListeners(page);
		this.attachDialogListener(page);
		this.page = page;
	}

	private attachConsoleListeners(page: Page): void {
		page.on("console", (msg) => {
			this.pushConsole({ type: "log", text: `[${msg.type()}] ${msg.text()}`, timestamp: Date.now() });
		});
		page.on("pageerror", (err) => {
			this.pushConsole({ type: "pageerror", text: err.message, timestamp: Date.now() });
		});
		page.on("requestfailed", (req) => {
			this.pushNetwork({
				type: "failed",
				url: req.url(),
				method: req.method(),
				status: 0,
				statusText: "",
				failure: req.failure()?.errorText ?? "unknown",
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

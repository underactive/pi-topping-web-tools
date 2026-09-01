import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BrowserManager } from "../src/web-browser/browser-manager.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "fixtures", "browser-fixture.html");

async function startFixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
	const html = await readFile(fixturePath, "utf-8");
	const server: Server = createServer((req, res) => {
		if (req.url === "/missing") {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("Not found");
			return;
		}
		if (req.url === "/slow") {
			setTimeout(() => {
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(html);
			}, 5000);
			return;
		}
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end(html);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	if (!addr || typeof addr === "string") {
		throw new Error("Failed to bind fixture server");
	}

	return {
		url: `http://127.0.0.1:${addr.port}/`,
		close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
	};
}

test("browser fixture integration", async () => {
	const fixture = await startFixtureServer();
	const browser = new BrowserManager();
	browser.setOriginChecker(() => true);

	try {
		const nav = await browser.navigate(fixture.url);
		assert.match(nav.title, /Browser Fixture/);
		assert.match(nav.url, /127\.0\.0\.1/);
		assert.match(nav.url, /^http:\/\//);

		const visibleText = await browser.getText();
		assert.match(visibleText, /Browser Test Fixture/);

		const visibleTextFromEmptySelector = await browser.getText("");
		assert.match(visibleTextFromEmptySelector, /Browser Test Fixture/);

		const markdown = await browser.getMarkdown();
		assert.match(markdown, /Browser Test Fixture/);
		assert.doesNotMatch(markdown, /<h1/);

		const a11y = await browser.getAccessibilitySnapshot();
		assert.match(a11y, /heading|Browser Test Fixture/i);

		const a11yFromEmptySelector = await browser.getAccessibilitySnapshot({ selector: "" });
		assert.match(a11yFromEmptySelector, /heading|Browser Test Fixture/i);

		const waitMsg = await browser.waitFor({ selector: "#delayed", state: "visible", timeout: 5000 });
		assert.match(waitMsg, /Wait satisfied/);

		const html = await browser.content();
		assert.match(html, /Browser Test Fixture/);

		await browser.fill("#search", "playwright");
		const clickMsg = await browser.click("#submit");
		assert.match(clickMsg, /Clicked/);

		await browser.fill("#typed", "ab", { mode: "press" });
		const typedLog = await browser.evaluate(
			"document.getElementById('typed-log').textContent",
		);
		assert.match(String(typedLog), /keydown:a/);
		assert.match(String(typedLog), /keydown:b/);

		const status = await browser.evaluate(
			"document.getElementById('status').textContent",
		);
		assert.equal(status, "Submitted");

		const result = await browser.evaluate(
			"document.getElementById('result').textContent",
		);
		assert.equal(result, "Submitted: playwright");

		const shot = await browser.screenshot();
		assert.ok(shot.data.length > 100);
		assert.ok(shot.width > 0);
		assert.ok(shot.height > 0);

		const tempDir = await mkdtemp(join(tmpdir(), "pi-web-browser-test-"));
		const tempFile = join(tempDir, "screenshot.png");
		await writeFile(tempFile, Buffer.from(shot.data, "base64"));
		const pngHeader = await readFile(tempFile);
		assert.equal(pngHeader[0], 0x89);
		assert.equal(pngHeader[1], 0x50);

		await browser.setCookies([{ name: "c1", value: "v1", url: fixture.url.replace(/\/$/, "") }]);
		const cookiesAfterSet = await browser.getCookies();
		assert.ok(cookiesAfterSet.some((c) => c.name === "c1" && c.value === "v1"));

		await browser.evaluate('fetch("/missing")');
		const networkLogs = browser.drainNetwork();
		assert.ok(
			networkLogs.some((e) => e.status >= 400 && e.url.includes("/missing")),
			`expected 404 for /missing, got: ${JSON.stringify(networkLogs)}`,
		);

		const logs = browser.drainConsole();
		assert.ok(logs.some((e) => e.text.includes("fixture-loaded")));
		assert.ok(logs.some((e) => e.text.includes("submitted:playwright")));

		const cookies = await browser.getCookies();
		assert.ok(cookies.some((c) => c.name === "fixture" && c.value === "test-value"));

		const badClick = await browser.click("#does-not-exist", { timeout: 500 });
		assert.match(badClick, /No element matches selector/);
		assert.match(badClick, /Matches: 0/);

		const waitInserted = await browser.waitFor({ selector: "#inserted-input", timeout: 5000 });
		assert.match(waitInserted, /Wait satisfied/);

		const fillInserted = await browser.fill("#inserted-input", "delayed");
		assert.match(fillInserted, /Typed into/);

		const clickInserted = await browser.click("#inserted-btn", { timeout: 5000 });
		assert.match(clickInserted, /Clicked/);

		const hoverMsg = await browser.hover("#hover-target");
		assert.match(hoverMsg, /Hovered/);
		const tooltipVisible = await browser.evaluate(
			"window.getComputedStyle(document.getElementById('tooltip')).display",
		);
		assert.equal(tooltipVisible, "block");

		await browser.fill("#search", "enter-test");
		const pressMsg = await browser.press("Enter");
		assert.match(pressMsg, /Pressed/);
		const enterResult = await browser.evaluate(
			"document.getElementById('result').textContent",
		);
		assert.equal(enterResult, "Submitted: enter-test");

		const selectMsg = await browser.selectOption("#test-select", ["option2"]);
		assert.match(selectMsg, /Selected/);
		const selectValue = await browser.evaluate(
			"document.getElementById('test-select').value",
		);
		assert.equal(selectValue, "option2");

		const viewportMsg = await browser.setViewport(800, 600);
		assert.match(viewportMsg, /Viewport set to 800×600/);
		const innerWidth = await browser.evaluate("window.innerWidth");
		assert.equal(innerWidth, 800);
		const viewportShot = await browser.screenshot();
		assert.equal(viewportShot.width, 800);
		assert.equal(viewportShot.height, 600);

		await browser.goBack();
		await browser.goForward();
		await browser.reload();
	} finally {
		await browser.close();
		await fixture.close();
	}
});

test("scroll, drag, upload, dialogs, role/text selectors, iframe, and tabs", async () => {
	const fixture = await startFixtureServer();
	const browser = new BrowserManager();
	browser.setOriginChecker(() => true);

	try {
		await browser.navigate(fixture.url);

		const scrollSelectorMsg = await browser.scroll({ selector: "#scroll-target" });
		assert.match(scrollSelectorMsg, /Scrolled "#scroll-target" into view/);
		const scrollYAfterSelector = await browser.evaluate("window.scrollY");
		assert.ok(Number(scrollYAfterSelector) > 0);

		await browser.evaluate("window.scrollTo(0, 0)");
		const scrollDeltaMsg = await browser.scroll({ deltaY: 300 });
		assert.match(scrollDeltaMsg, /Scrolled by \(0, 300\)/);

		const dragMsg = await browser.drag("#drag-source", "#drop-target");
		assert.match(dragMsg, /Dragged/);
		const dragResult = await browser.evaluate("document.getElementById('drag-result').textContent");
		assert.equal(dragResult, "dropped");

		const tempDir = await mkdtemp(join(tmpdir(), "pi-web-browser-upload-"));
		const uploadFile = join(tempDir, "note.txt");
		await writeFile(uploadFile, "hello");
		const uploadMsg = await browser.uploadFile("#file-input", [uploadFile]);
		assert.match(uploadMsg, /Uploaded 1 file/);
		const fileLog = await browser.evaluate("document.getElementById('file-log').textContent");
		assert.equal(fileLog, "note.txt");

		browser.setDialogBehavior("accept", "my-value");
		await browser.click("#prompt-btn");
		const promptResult = await browser.evaluate("document.getElementById('dialog-result').textContent");
		assert.equal(promptResult, "prompt:my-value");

		browser.setDialogBehavior("dismiss");
		await browser.click("#confirm-btn");
		const confirmResult = await browser.evaluate("document.getElementById('dialog-result').textContent");
		assert.equal(confirmResult, "confirm:false");

		const dialogs = browser.drainDialogs();
		assert.ok(dialogs.some((d) => d.type === "prompt" && d.action === "accept"));
		assert.ok(dialogs.some((d) => d.type === "confirm" && d.action === "dismiss"));

		const roleClickMsg = await browser.click("role=button[name='Submit']");
		assert.match(roleClickMsg, /Clicked/);

		const textHoverMsg = await browser.hover("text=Hover me");
		assert.match(textHoverMsg, /Hovered/);

		const frameClickMsg = await browser.click("#frame-btn", { frame: "#test-frame" });
		assert.match(frameClickMsg, /Clicked/);
		const frameResult = await browser.getText("#frame-result", { frame: "#test-frame" });
		assert.equal(frameResult, "frame-clicked");

		await browser.click("#popup-link");
		let tabs = await browser.listTabs();
		for (let i = 0; i < 30 && tabs.length < 2; i++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			tabs = await browser.listTabs();
		}
		assert.equal(tabs.length, 2);
		assert.ok(tabs.some((t) => t.active));

		const switchMsg = await browser.switchTab(0);
		assert.match(switchMsg, /Switched to tab 0/);

		const badSwitchMsg = await browser.switchTab(99);
		assert.match(badSwitchMsg, /Invalid tab index/);
	} finally {
		await browser.close();
		await fixture.close();
	}
});

test("abort signal cancels navigation and browser remains usable", async () => {
	const fixture = await startFixtureServer();
	const browser = new BrowserManager();
	browser.setOriginChecker(() => true);
	const controller = new AbortController();

	try {
		const slowUrl = fixture.url.replace(/\/$/, "") + "/slow";
		const navPromise = browser.navigate(slowUrl, { signal: controller.signal, timeout: 10_000 });
		setTimeout(() => controller.abort(), 100);

		await assert.rejects(navPromise, (err: unknown) => {
			return err instanceof DOMException && err.name === "AbortError";
		});

		const nav = await browser.navigate(fixture.url);
		assert.match(nav.title, /Browser Fixture/);
	} finally {
		await browser.close();
		await fixture.close();
	}
});

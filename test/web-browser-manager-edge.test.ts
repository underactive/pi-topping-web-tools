import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	AsyncMutex,
	BrowserManager,
	MAX_FULL_PAGE_WIDTH,
} from "../src/web-browser/browser-manager.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "fixtures", "browser-fixture.html");

async function startFixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
	const html = await readFile(fixturePath, "utf-8");
	const server: Server = createServer((req, res) => {
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

test("AsyncMutex serializes overlapping operations and drain waits for all", async () => {
	const mutex = new AsyncMutex();
	const order: string[] = [];
	let releaseFirst!: () => void;
	const gate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});

	const first = mutex.run(async () => {
		order.push("first:start");
		await gate;
		order.push("first:end");
		return 1;
	});

	while (order.length === 0) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	const second = mutex.run(async () => {
		order.push("second");
		return 2;
	});

	let drained = false;
	const drainPromise = mutex.drain().then(() => {
		drained = true;
	});

	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(order, ["first:start"]);
	assert.equal(drained, false);

	releaseFirst();
	assert.deepEqual(await Promise.all([first, second]), [1, 2]);
	assert.deepEqual(order, ["first:start", "first:end", "second"]);
	await drainPromise;
	assert.equal(drained, true);
});

test("full-page screenshot width is clamped to MAX_FULL_PAGE_WIDTH", async () => {
	const browser = new BrowserManager();
	browser.setOriginChecker(() => true);
	try {
		await browser.navigate(`file://${fixturePath}`);
		await browser.evaluate(
			"document.body.innerHTML = '<div style=\"width: 3000px; height: 50px\"></div>'",
		);
		const shot = await browser.screenshot({ fullPage: true });
		assert.equal(shot.width, MAX_FULL_PAGE_WIDTH);
		assert.ok(shot.height > 0);
		assert.equal(shot.fullPage, true);
	} finally {
		await browser.close();
	}
});

test("close(timeoutMs) resolves within the timeout when cleanup stalls", async () => {
	const browser = new BrowserManager();
	Object.defineProperty(browser, "cleanup", {
		configurable: true,
		value: () => new Promise<void>(() => {}),
	});
	const start = Date.now();
	await browser.close(50);
	assert.ok(Date.now() - start < 2000, "close should not hang on a stalled cleanup");
});

test("ensureLaunched recovers on the remaining tab when the active tab closes", async () => {
	const fixture = await startFixtureServer();
	const browser = new BrowserManager();
	browser.setOriginChecker(() => true);
	try {
		await browser.navigate(fixture.url);
		await browser.click("#popup-link");

		let tabs = await browser.listTabs();
		for (let i = 0; i < 30 && tabs.length < 2; i++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			tabs = await browser.listTabs();
		}
		assert.equal(tabs.length, 2);

		// The popup is the active tab; close it from its own window context.
		await browser.evaluate("window.close()");

		for (let i = 0; i < 30 && tabs.length > 1; i++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			tabs = await browser.listTabs();
		}
		assert.equal(tabs.length, 1);

		const text = await browser.getText();
		assert.match(text, /Browser Test Fixture/);
		const info = await browser.getPageInfoAsync();
		assert.match(info.url, /127\.0\.0\.1/);
	} finally {
		await browser.close();
		await fixture.close();
	}
});

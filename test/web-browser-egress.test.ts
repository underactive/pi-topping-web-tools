import assert from "node:assert/strict";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { test } from "node:test";
import type { Route, WebSocketRoute } from "playwright";
import { BrowserManager } from "../src/web-browser/browser-manager.ts";

type TestServer = {
	origin: string;
	requests: string[];
	close: () => Promise<void>;
};

type WebSocketSink = {
	url: string;
	upgradeCount: () => number;
	close: () => Promise<void>;
};

type BrowserManagerInternals = {
	enforceEgress(route: Route): Promise<void>;
	enforceWebSocketEgress(webSocket: WebSocketRoute): Promise<void>;
};

async function startServer(
	handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<TestServer> {
	const requests: string[] = [];
	const server: Server = createServer((request, response) => {
		requests.push(request.url ?? "");
		handler(request, response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Failed to bind test server");
	return {
		origin: `http://127.0.0.1:${address.port}`,
		requests,
		close: () =>
			new Promise((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
				server.closeAllConnections();
			}),
	};
}

async function startWebSocketSink(): Promise<WebSocketSink> {
	let upgrades = 0;
	const server = createServer((_request, response) => {
		response.writeHead(426);
		response.end();
	});
	server.on("upgrade", (_request, socket) => {
		upgrades++;
		socket.destroy();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Failed to bind WebSocket sink");
	return {
		url: `ws://127.0.0.1:${address.port}/socket`,
		upgradeCount: () => upgrades,
		close: () =>
			new Promise((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
				server.closeAllConnections();
			}),
	};
}

function fakeRoute(url: string, resourceType = "xhr", pageUrl = "https://page.example/") {
	const state = {
		continued: 0,
		fulfilled: 0,
		aborted: 0,
		abortCode: "",
	};
	const mainFrame: Record<string, unknown> = {};
	const page = { url: () => pageUrl, mainFrame: () => mainFrame };
	mainFrame.page = () => page;
	const route = {
		request: () => ({
			url: () => url,
			resourceType: () => resourceType,
			method: () => "GET",
			frame: () => mainFrame,
		}),
		continue: async () => {
			state.continued++;
		},
		fetch: async () => {
			state.continued++;
			return {
				status: () => 200,
				headers: () => ({}),
				dispose: async () => {},
			};
		},
		fulfill: async () => {
			state.fulfilled++;
		},
		abort: async (code?: string) => {
			state.aborted++;
			state.abortCode = code ?? "";
		},
	} as unknown as Route;
	return { route, state };
}

function fakeWebSocket(url: string) {
	const state = { connected: 0, closed: 0 };
	const webSocket = {
		url: () => url,
		connectToServer: () => {
			state.connected++;
		},
		close: async () => {
			state.closed++;
		},
	} as unknown as WebSocketRoute;
	return { webSocket, state };
}

test("BrowserManager defaults to denying HTTP egress", async () => {
	const browser = new BrowserManager();
	const internal = browser as unknown as BrowserManagerInternals;
	const { route, state } = fakeRoute("https://denied.example/data");

	await internal.enforceEgress(route);

	assert.equal(state.continued, 0);
	assert.equal(state.fulfilled, 0);
	assert.equal(state.aborted, 1);
	assert.equal(state.abortCode, "blockedbyclient");
	assert.deepEqual(
		browser.drainNetwork().map((entry) => ({ url: entry.url, failure: entry.failure })),
		[
			{
				url: "https://denied.example/data",
				failure: "blocked by egress policy: URL is not approved: https://denied.example",
			},
		],
	);
});

test("BrowserManager rechecks every request and redirect origin", async () => {
	const browser = new BrowserManager();
	browser.setOriginChecker((url) => new URL(url).origin === "https://allowed.example");
	const internal = browser as unknown as BrowserManagerInternals;
	const first = fakeRoute("https://allowed.example/start", "document", "about:blank");
	const redirected = fakeRoute(
		"https://redirected.example/landing",
		"document",
		"https://allowed.example/start",
	);

	await internal.enforceEgress(first.route);
	await internal.enforceEgress(redirected.route);

	assert.equal(first.state.continued, 1);
	assert.equal(first.state.fulfilled, 1);
	assert.equal(first.state.aborted, 0);
	assert.equal(redirected.state.continued, 0);
	assert.equal(redirected.state.aborted, 1);
	assert.ok(
		browser.drainNetwork().some(
			(entry) =>
				entry.url === "https://redirected.example/landing" &&
				entry.failure?.includes("blocked by egress policy"),
		),
	);
});

test("BrowserManager gates WebSocket connections with the live checker", async () => {
	const browser = new BrowserManager();
	const internal = browser as unknown as BrowserManagerInternals;
	const denied = fakeWebSocket("wss://denied.example/socket");
	await internal.enforceWebSocketEgress(denied.webSocket);
	assert.deepEqual(denied.state, { connected: 0, closed: 1 });

	browser.setOriginChecker((url) => url === "wss://allowed.example/socket");
	const allowed = fakeWebSocket("wss://allowed.example/socket");
	await internal.enforceWebSocketEgress(allowed.webSocket);
	assert.deepEqual(allowed.state, { connected: 1, closed: 0 });
});

test("redirects to an unapproved origin are blocked before reaching the server", async () => {
	const blocked = await startServer((_request, response) => {
		response.writeHead(200, { "Content-Type": "text/html" });
		response.end("blocked origin reached");
	});
	const allowed = await startServer((request, response) => {
		if (request.url === "/redirect") {
			response.writeHead(302, { Location: `${blocked.origin}/landing` });
			response.end();
			return;
		}
		response.writeHead(200, { "Content-Type": "text/html" });
		response.end("<!doctype html><title>Allowed</title><h1>Allowed</h1>");
	});
	const browser = new BrowserManager();
	browser.setOriginChecker((url) => new URL(url).origin === allowed.origin);

	try {
		await assert.rejects(
			browser.navigate(`${allowed.origin}/redirect`),
			(err: unknown) =>
				err instanceof Error &&
				err.message === `Blocked: redirect to ${blocked.origin} requires approval`,
		);
		assert.deepEqual(blocked.requests, []);
		assert.ok(
			browser.drainNetwork().some(
				(entry) => entry.url === `${blocked.origin}/landing` && entry.failure?.includes("egress policy"),
			),
		);
	} finally {
		await browser.close();
		await allowed.close();
		await blocked.close();
	}
});

test("approved redirect chains are followed one gated hop at a time", async () => {
	const server = await startServer((request, response) => {
		if (request.url === "/one") {
			response.writeHead(302, { Location: "/two" });
			response.end();
			return;
		}
		if (request.url === "/two") {
			response.writeHead(307, { Location: "/final" });
			response.end();
			return;
		}
		response.writeHead(200, { "Content-Type": "text/html" });
		response.end("<!doctype html><title>Final</title><h1>Final</h1>");
	});
	const browser = new BrowserManager();
	browser.setOriginChecker((url) => new URL(url).origin === server.origin);

	try {
		const result = await browser.navigate(`${server.origin}/one`);
		assert.equal(result.url, `${server.origin}/final`);
		assert.equal(result.title, "Final");
		assert.equal(result.statusCode, 200);
		assert.deepEqual(server.requests, ["/one", "/two", "/final"]);
		assert.deepEqual(browser.drainNetwork(), []);
	} finally {
		await browser.close();
		await server.close();
	}
});

test("cross-origin fetches are blocked and reported", async () => {
	const blocked = await startServer((_request, response) => {
		response.writeHead(204);
		response.end();
	});
	const allowed = await startServer((_request, response) => {
		response.writeHead(200, { "Content-Type": "text/html" });
		response.end("<!doctype html><title>Allowed</title><h1>Allowed</h1>");
	});
	const browser = new BrowserManager();
	browser.setOriginChecker((url) => new URL(url).origin === allowed.origin);

	try {
		await browser.navigate(allowed.origin);
		const result = await browser.evaluate(
			`fetch(${JSON.stringify(`${blocked.origin}/exfil`)}).then(() => "sent", () => "blocked")`,
		);
		assert.equal(result, "blocked");
		assert.deepEqual(blocked.requests, []);
		assert.ok(
			browser.drainNetwork().some(
				(entry) => entry.url === `${blocked.origin}/exfil` && entry.failure?.includes("egress policy"),
			),
		);
	} finally {
		await browser.close();
		await allowed.close();
		await blocked.close();
	}
});

test("client-side cross-origin navigation is blocked without replacing the approved page", async () => {
	const blocked = await startServer((_request, response) => {
		response.writeHead(200, { "Content-Type": "text/html" });
		response.end("blocked navigation reached");
	});
	const allowed = await startServer((_request, response) => {
		response.writeHead(200, { "Content-Type": "text/html" });
		response.end("<!doctype html><title>Allowed</title><h1>Allowed</h1>");
	});
	const browser = new BrowserManager();
	browser.setOriginChecker((url) => new URL(url).origin === allowed.origin);

	try {
		await browser.navigate(allowed.origin);
		await browser.evaluate(`location.assign(${JSON.stringify(`${blocked.origin}/landing`)})`);

		for (let i = 0; i < 30; i++) {
			const info = await browser.getPageInfoAsync();
			if (info.networkCount > 0 && info.url.startsWith(allowed.origin)) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		const info = await browser.getPageInfoAsync();
		assert.equal(new URL(info.url).origin, allowed.origin);
		assert.deepEqual(blocked.requests, []);
		assert.ok(
			browser.drainNetwork().some(
				(entry) =>
					entry.url === `${blocked.origin}/landing` && entry.failure?.includes("egress policy"),
			),
		);
	} finally {
		await browser.close();
		await allowed.close();
		await blocked.close();
	}
});

test("blocked WebSocket handshakes never reach the target server", async () => {
	const sink = await startWebSocketSink();
	const allowed = await startServer((_request, response) => {
		response.writeHead(200, { "Content-Type": "text/html" });
		response.end("<!doctype html><title>Allowed</title><h1>Allowed</h1>");
	});
	const browser = new BrowserManager();
	browser.setOriginChecker((url) => new URL(url).origin === allowed.origin);

	try {
		await browser.navigate(allowed.origin);
		const result = await browser.evaluate(
			`new Promise((resolve) => {
				const socket = new WebSocket(${JSON.stringify(sink.url)});
				socket.addEventListener("open", () => resolve("opened"));
				socket.addEventListener("error", () => resolve("blocked"));
				setTimeout(() => resolve("timeout"), 250);
			})`,
		);
		assert.notEqual(result, "opened");
		assert.equal(sink.upgradeCount(), 0);
		assert.ok(
			browser.drainNetwork().some(
				(entry) => entry.url === sink.url && entry.failure?.includes("WebSocket URL is not approved"),
			),
		);
	} finally {
		await browser.close();
		await allowed.close();
		await sink.close();
	}
});

test("blocked popups close without replacing the approved active tab", async () => {
	const blocked = await startServer((_request, response) => {
		response.writeHead(200, { "Content-Type": "text/html" });
		response.end("blocked popup reached");
	});
	const allowed = await startServer((_request, response) => {
		response.writeHead(200, { "Content-Type": "text/html" });
		response.end(
			`<!doctype html><title>Allowed</title><a id="popup" target="_blank" href="${blocked.origin}/popup">Open</a>`,
		);
	});
	const browser = new BrowserManager();
	browser.setOriginChecker((url) => new URL(url).origin === allowed.origin);

	try {
		await browser.navigate(allowed.origin);
		await browser.click("#popup");

		for (let i = 0; i < 30; i++) {
			const info = await browser.getPageInfoAsync();
			if (info.networkCount > 0) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		const tabs = await browser.listTabs();
		assert.equal(tabs.length, 1);
		assert.equal(tabs[0]?.active, true);
		assert.equal(new URL(tabs[0]!.url).origin, allowed.origin);
		assert.deepEqual(blocked.requests, []);
		assert.ok(
			browser.drainNetwork().some(
				(entry) => entry.url === `${blocked.origin}/popup` && entry.failure?.includes("egress policy"),
			),
		);
	} finally {
		await browser.close();
		await allowed.close();
		await blocked.close();
	}
});

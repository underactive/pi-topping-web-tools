import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { addGrant, DAY_MS } from "../src/permission-store.ts";
import {
	buildOriginChecker,
	decideRequest,
} from "../src/web-browser/egress-policy.ts";

let tempDir: string;
let originalPermissionsFile: string | undefined;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "egress-policy-test-"));
	originalPermissionsFile = process.env.PI_WEB_TOOLS_PERMISSIONS_FILE;
	process.env.PI_WEB_TOOLS_PERMISSIONS_FILE = join(tempDir, "web-permissions.json");
});

afterEach(async () => {
	if (originalPermissionsFile === undefined) {
		delete process.env.PI_WEB_TOOLS_PERMISSIONS_FILE;
	} else {
		process.env.PI_WEB_TOOLS_PERMISSIONS_FILE = originalPermissionsFile;
	}
	await rm(tempDir, { recursive: true, force: true });
});

test("decideRequest permits approved HTTP(S) URLs and denies unapproved URLs", () => {
	assert.deepEqual(
		decideRequest("https://allowed.example/path", "document", "about:blank", () => true),
		{ allow: true },
	);
	assert.deepEqual(
		decideRequest("http://denied.example/path", "xhr", "https://page.example/", () => false),
		{ allow: false, reason: "URL is not approved: http://denied.example" },
	);
});

test("decideRequest fails closed for malformed URLs and checker errors", () => {
	assert.deepEqual(decideRequest("not a URL", "xhr", "https://page.example/", () => true), {
		allow: false,
		reason: "Invalid request URL",
	});
	assert.deepEqual(
		decideRequest("https://allowed.example/", "xhr", "https://page.example/", () => {
			throw new Error("store unavailable");
		}),
		{ allow: false, reason: "Permission check failed" },
	);
});

test("decideRequest allows the network-free about:blank document", () => {
	assert.deepEqual(decideRequest("about:blank", "document", "https://page.example/", () => false), {
		allow: true,
	});
});

test("decideRequest allows data/blob subresources but denies document navigation", () => {
	for (const url of ["data:text/plain,hello", "blob:https://page.example/id"]) {
		assert.deepEqual(decideRequest(url, "image", "https://page.example/", () => false), {
			allow: true,
		});
		const decision = decideRequest(url, "document", "https://page.example/", () => true);
		assert.equal(decision.allow, false);
	}
});

test("decideRequest denies unsupported network protocols", () => {
	assert.deepEqual(
		decideRequest("ftp://files.example/archive", "document", "https://page.example/", () => true),
		{ allow: false, reason: "Unsupported request protocol: ftp:" },
	);
});

test("decideRequest permits an approved initial file document", () => {
	const decision = decideRequest(
		"file:///tmp/page.html",
		"document",
		"about:blank",
		(url) => url === "file:///tmp/page.html",
	);
	assert.deepEqual(decision, { allow: true });
});

test("decideRequest permits file subresources only from an approved file page", () => {
	const checker = (url: string) => url === "file:///tmp/page.html" || url === "file:///tmp/style.css";
	assert.deepEqual(
		decideRequest("file:///tmp/style.css", "stylesheet", "file:///tmp/page.html", checker),
		{ allow: true },
	);
	assert.deepEqual(
		decideRequest("file:///tmp/secret.txt", "fetch", "https://page.example/", () => true),
		{ allow: false, reason: "Local-file subrequests require a local-file page" },
	);
	assert.deepEqual(
		decideRequest("file:///tmp/style.css", "stylesheet", "file:///tmp/page.html", () => false),
		{ allow: false, reason: "Local file is not approved: file:///tmp/style.css" },
	);
});

test("buildOriginChecker preserves path-scoped preapprovals", () => {
	const checker = buildOriginChecker(new Map());
	assert.equal(checker("https://github.com/anthropics/sdk"), true);
	assert.equal(checker("https://github.com/unapproved/path"), false);
	assert.equal(checker("https://vercel.com/docs/functions"), true);
	assert.equal(checker("https://vercel.com/templates"), false);
});

test("buildOriginChecker reads live session decisions", () => {
	const session = new Map<string, "allow" | "deny">();
	const checker = buildOriginChecker(session);

	assert.equal(checker("https://dynamic.example/path"), false);
	session.set("https://dynamic.example", "allow");
	assert.equal(checker("https://dynamic.example/path"), true);
	session.set("https://dynamic.example", "deny");
	assert.equal(checker("https://dynamic.example/path"), false);

	session.set("file:///tmp/page.html", "allow");
	assert.equal(checker("file:///tmp/page.html"), true);
	assert.equal(checker("file:///tmp/other.html"), false);
});

test("buildOriginChecker treats bare and www host grants as equivalent", () => {
	const bareSession = new Map<string, "allow" | "deny">([
		["https://apple.com", "allow"],
	]);
	const bareChecker = buildOriginChecker(bareSession);
	assert.equal(bareChecker("https://www.apple.com/page"), true);
	assert.equal(bareChecker("https://store.apple.com/page"), false);
	assert.equal(bareChecker("http://www.apple.com/page"), false);
	assert.equal(bareChecker("https://www.apple.com:8443/page"), false);

	const wwwChecker = buildOriginChecker(
		new Map<string, "allow" | "deny">([["https://www.example.com", "allow"]]),
	);
	assert.equal(wwwChecker("https://example.com/page"), true);

	bareSession.set("https://www.apple.com", "deny");
	assert.equal(bareChecker("https://www.apple.com/page"), false);
});

test("buildOriginChecker does not apply www equivalence to local or IP hosts", () => {
	const checker = buildOriginChecker(
		new Map<string, "allow" | "deny">([
			["http://localhost:3000", "allow"],
			["http://127.0.0.1:3000", "allow"],
			["http://dev.local:3000", "allow"],
		]),
	);
	assert.equal(checker("http://www.localhost:3000/"), false);
	assert.equal(checker("http://www.127.0.0.1:3000/"), false);
	assert.equal(checker("http://www.dev.local:3000/"), false);
});

test("buildOriginChecker reads durable grants and normalizes WebSocket schemes", async () => {
	await addGrant("web_browser", "https://socket.example", DAY_MS);
	const checker = buildOriginChecker(new Map());
	assert.equal(checker("https://socket.example/path"), true);
	assert.equal(checker("https://www.socket.example/path"), true);
	assert.equal(checker("wss://socket.example/path"), true);
	assert.equal(checker("wss://www.socket.example/path"), true);
	assert.equal(checker("ws://socket.example/path"), false);
});

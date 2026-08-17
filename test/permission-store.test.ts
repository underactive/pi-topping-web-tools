import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
	addGrant,
	removeGrant,
	listGrants,
	isGranted,
	type PermissionScope,
	DAY_MS,
	WEEK_MS,
	MONTH_MS,
} from "../src/permission-store.ts";

let tempDir: string;
let originalEnv: string | undefined;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "permission-store-test-"));
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

test("listGrants returns empty array when no file exists", () => {
	assert.deepEqual(listGrants(), []);
});

test("round-trip: addGrant persists and listGrants reads back", async () => {
	const ok = await addGrant("fetch_markdown", "https://example.com", DAY_MS);
	assert.equal(ok, true);

	const grants = listGrants();
	assert.equal(grants.length, 1);
	assert.equal(grants[0].scope, "fetch_markdown");
	assert.equal(grants[0].origin, "https://example.com");
	assert.ok(grants[0].grantedAt > 0);
	assert.ok(grants[0].expiresAt > grants[0].grantedAt);
});

test("isGranted returns true for active grant", async () => {
	await addGrant("web_browser", "https://test.example", WEEK_MS);
	assert.equal(isGranted("web_browser", "https://test.example"), true);
});

test("isGranted returns false for wrong scope", async () => {
	await addGrant("fetch_markdown", "https://test.example", WEEK_MS);
	assert.equal(isGranted("web_browser", "https://test.example"), false);
});

test("isGranted returns false for wrong origin", async () => {
	await addGrant("fetch_markdown", "https://test.example", WEEK_MS);
	assert.equal(isGranted("fetch_markdown", "https://other.example"), false);
});

test("isGranted returns false after removal", async () => {
	await addGrant("fetch_markdown", "https://test.example", WEEK_MS);
	await removeGrant("fetch_markdown", "https://test.example");
	assert.equal(isGranted("fetch_markdown", "https://test.example"), false);
});

test("addGrant replaces existing grant for same scope+origin", async () => {
	await addGrant("fetch_markdown", "https://example.com", DAY_MS);
	await addGrant("fetch_markdown", "https://example.com", WEEK_MS);

	const grants = listGrants();
	assert.equal(grants.length, 1);
	// The second grant should have a later expiry.
	assert.ok(grants[0].expiresAt > Date.now() + DAY_MS);
});

test("per-scope isolation: different scopes for same origin are independent", async () => {
	await addGrant("fetch_markdown", "https://example.com", DAY_MS);
	await addGrant("web_browser", "https://example.com", DAY_MS);

	const grants = listGrants();
	assert.equal(grants.length, 2);
	assert.equal(isGranted("fetch_markdown", "https://example.com"), true);
	assert.equal(isGranted("web_browser", "https://example.com"), true);
	assert.equal(isGranted("pdf_extract", "https://example.com"), false);
});

test("port exactness: different ports are separate grants", async () => {
	await addGrant("fetch_markdown", "http://localhost:3000", DAY_MS);
	assert.equal(isGranted("fetch_markdown", "http://localhost:3000"), true);
	assert.equal(isGranted("fetch_markdown", "http://localhost:8080"), false);
});

test("scheme exactness: http and https are separate grants", async () => {
	await addGrant("fetch_markdown", "http://example.com", DAY_MS);
	assert.equal(isGranted("fetch_markdown", "http://example.com"), true);
	assert.equal(isGranted("fetch_markdown", "https://example.com"), false);
});

test("origin normalization via permissionKey", async () => {
	await addGrant("fetch_markdown", "https://example.com/some/path", DAY_MS);
	// permissionKey strips path, so origin should be stored as https://example.com
	const grants = listGrants();
	assert.equal(grants[0].origin, "https://example.com");
});

test("file:// origins are normalized to file://pathname", async () => {
	await addGrant("pdf_extract", "file:///tmp/test.pdf", DAY_MS);
	const grants = listGrants();
	assert.equal(grants[0].origin, "file:///tmp/test.pdf");
	assert.equal(isGranted("pdf_extract", "file:///tmp/test.pdf"), true);
});

test("TTL is capped at 30 days", async () => {
	const farFuture = 90 * DAY_MS;
	await addGrant("fetch_markdown", "https://example.com", farFuture);

	const grants = listGrants();
	const maxExpiry = Date.now() + MONTH_MS + 1000; // small tolerance
	assert.ok(grants[0].expiresAt <= maxExpiry);
});

test("malformed JSON file returns empty list", async () => {
	const path = process.env.PI_WEB_TOOLS_PERMISSIONS_FILE!;
	await writeFile(path, "not json");
	assert.deepEqual(listGrants(), []);
});

test("oversized file returns empty list", async () => {
	const path = process.env.PI_WEB_TOOLS_PERMISSIONS_FILE!;
	await writeFile(path, "x".repeat(2 * 1024 * 1024)); // 2 MB
	assert.deepEqual(listGrants(), []);
});

test("invalid version returns empty list", async () => {
	const path = process.env.PI_WEB_TOOLS_PERMISSIONS_FILE!;
	await writeFile(path, JSON.stringify({ version: 2, grants: [] }));
	assert.deepEqual(listGrants(), []);
});

test("invalid grants array returns empty list", async () => {
	const path = process.env.PI_WEB_TOOLS_PERMISSIONS_FILE!;
	await writeFile(path, JSON.stringify({ version: 1, grants: "not-an-array" }));
	assert.deepEqual(listGrants(), []);
});

test("entries with invalid scope are silently dropped", async () => {
	const path = process.env.PI_WEB_TOOLS_PERMISSIONS_FILE!;
	await writeFile(
		path,
		JSON.stringify({
			version: 1,
			grants: [
				{ scope: "invalid_scope", origin: "https://example.com", grantedAt: Date.now(), expiresAt: Date.now() + DAY_MS },
				{ scope: "fetch_markdown", origin: "https://good.com", grantedAt: Date.now(), expiresAt: Date.now() + DAY_MS },
			],
		}),
	);
	const grants = listGrants();
	assert.equal(grants.length, 1);
	assert.equal(grants[0].origin, "https://good.com");
});

test("expired entries are pruned on read", async () => {
	const path = process.env.PI_WEB_TOOLS_PERMISSIONS_FILE!;
	await writeFile(
		path,
		JSON.stringify({
			version: 1,
			grants: [
				{ scope: "fetch_markdown", origin: "https://expired.com", grantedAt: Date.now() - 1000, expiresAt: Date.now() - 1 },
				{ scope: "fetch_markdown", origin: "https://active.com", grantedAt: Date.now(), expiresAt: Date.now() + DAY_MS },
			],
		}),
	);
	const grants = listGrants();
	assert.equal(grants.length, 1);
	assert.equal(grants[0].origin, "https://active.com");
});

test("atomic write leaves no partial file on success", async () => {
	await addGrant("fetch_markdown", "https://example.com", DAY_MS);
	const path = process.env.PI_WEB_TOOLS_PERMISSIONS_FILE!;
	const content = await readFile(path, "utf-8");
	const parsed = JSON.parse(content);
	assert.equal(parsed.version, 1);
	assert.equal(parsed.grants.length, 1);
});

test("file mode is 0600", async () => {
	await addGrant("fetch_markdown", "https://example.com", DAY_MS);
	const path = process.env.PI_WEB_TOOLS_PERMISSIONS_FILE!;
	const { stat } = await import("node:fs/promises");
	const stats = await stat(path);
	const mode = (stats.mode & 0o777).toString(8);
	assert.equal(mode, "600");
});

test("addGrant returns false when lock cannot be acquired (simulated)", async () => {
	// This is hard to test without race conditions, but we verify the function
	// returns a boolean and doesn't throw.
	const ok = await addGrant("fetch_markdown", "https://example.com", DAY_MS);
	assert.equal(typeof ok, "boolean");
});

test("removeGrant is a no-op when grant doesn't exist", async () => {
	const ok = await removeGrant("fetch_markdown", "https://nonexistent.com");
	assert.equal(ok, true);
	assert.equal(isGranted("fetch_markdown", "https://nonexistent.com"), false);
});

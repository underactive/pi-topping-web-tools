import assert from "node:assert/strict";
import { test } from "node:test";
import { validateURL } from "../src/fetch-markdown.ts";

test("validateURL rejects loopback and private hosts", () => {
	assert.equal(validateURL("http://127.0.0.1.example.com/"), true);
	assert.equal(validateURL("http://127.0.0.1/"), false);
	assert.equal(validateURL("http://10.0.0.1/"), false);
	assert.equal(validateURL("http://169.254.1.1/"), false);
});

test("validateURL rejects link-local metadata hosts", () => {
	assert.equal(validateURL("http://169.254.169.254/latest/meta-data/"), false);
});

test("validateURL rejects 0.0.0.0/8 loopback-mapped addresses", () => {
	assert.equal(validateURL("http://0.0.0.0/"), false);
	assert.equal(validateURL("http://0.0.0.1/"), false);
});

test("validateURL rejects non-http(s) schemes", () => {
	assert.equal(validateURL("file:///etc/passwd"), false);
	assert.equal(validateURL("javascript:alert(1)"), false);
	assert.equal(validateURL("ftp://example.com/"), false);
});

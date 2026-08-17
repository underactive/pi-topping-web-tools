import assert from "node:assert/strict";
import { test } from "node:test";
import { isPreapprovedHost } from "../src/permissions.ts";

test("isPreapprovedHost hostname-only match", () => {
	assert.equal(isPreapprovedHost("react.dev", "/"), true);
	assert.equal(isPreapprovedHost("react.dev", "/learn"), true);
});

test("isPreapprovedHost path-prefix match", () => {
	assert.equal(isPreapprovedHost("github.com", "/anthropics/claude-code"), true);
	assert.equal(isPreapprovedHost("github.com", "/anthropics"), true);
});

test("isPreapprovedHost path-prefix miss", () => {
	assert.equal(isPreapprovedHost("github.com", "/other/repo"), false);
	assert.equal(isPreapprovedHost("github.com", "/"), false);
});

test("isPreapprovedHost subdomain non-match", () => {
	assert.equal(isPreapprovedHost("foo.example.com", "/"), false);
	assert.equal(isPreapprovedHost("docs.react.dev", "/"), false);
});

test("isPreapprovedHost unknown host", () => {
	assert.equal(isPreapprovedHost("evil.example", "/"), false);
});

test("isPreapprovedHost exact vs prefix", () => {
	assert.equal(isPreapprovedHost("vercel.com", "/docs"), true);
	assert.equal(isPreapprovedHost("vercel.com", "/docs/getting-started"), true);
	assert.equal(isPreapprovedHost("vercel.com", "/blog"), false);
});

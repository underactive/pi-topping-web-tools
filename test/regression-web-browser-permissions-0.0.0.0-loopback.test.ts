import assert from "node:assert/strict";
import { test } from "node:test";
import { isLocalOrPrivateHost } from "../src/web-browser/permissions.ts";

test("isLocalOrPrivateHost treats 0.0.0.0/8 as loopback", () => {
	assert.equal(isLocalOrPrivateHost("0.0.0.0"), true);
	assert.equal(isLocalOrPrivateHost("0.0.0.1"), true);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { isTruthyEnvFlag, suppressNotifications } from "../src/env.ts";

test("isTruthyEnvFlag accepts pi's supported truthy values", () => {
	for (const value of ["1", "true", "TRUE", "yes", "YES"]) {
		assert.equal(isTruthyEnvFlag(value), true, value);
	}
	for (const value of [undefined, "", "0", "false", "no", " true "]) {
		assert.equal(isTruthyEnvFlag(value), false, value);
	}
});

test("suppressNotifications reads PI_SUPPRESS_NOTIFICATIONS", () => {
	assert.equal(suppressNotifications({ PI_SUPPRESS_NOTIFICATIONS: "yes" }), true);
	assert.equal(suppressNotifications({ PI_SUPPRESS_NOTIFICATIONS: "0" }), false);
});

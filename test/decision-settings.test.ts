import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
	classifierValue,
	decisionFromMenuValues,
	decisionMenuSections,
} from "../src/decision/settings-menu.ts";
import {
	DEFAULT_DECISION_SETTINGS,
	loadDecisionSettings,
	loadToolExposureMode,
	sanitizeDecisionSettings,
	saveDecisionSettings,
} from "../src/tool-exposure.ts";
import { enabledSettings, settingsFile } from "./decision-harness.ts";

test("the decision gate is off by default with auto classifier and routesense's bounds", () => {
	assert.deepEqual(sanitizeDecisionSettings(undefined), {
		enabled: false,
		mode: "classifier-tool",
		provider: "auto",
		model: "auto",
		timeoutMs: 3000,
		circuitBreakerEnabled: true,
		circuitBreakerCooldownSeconds: 30,
	});
	assert.deepEqual(loadDecisionSettings(join(tmpdir(), "pi-web-tools-missing-decision.json")), DEFAULT_DECISION_SETTINGS);
	assert.deepEqual(loadDecisionSettings(settingsFile("{")), DEFAULT_DECISION_SETTINGS);
});

test("sanitize rejects an unknown mode and out-of-range numbers", () => {
	const settings = sanitizeDecisionSettings({
		enabled: true,
		mode: "intercept",
		timeoutMs: 0,
		circuitBreakerCooldownSeconds: -1,
		circuitBreakerEnabled: "yes",
	});
	assert.equal(settings.enabled, true);
	assert.equal(settings.mode, "classifier-tool");
	assert.equal(settings.timeoutMs, 3000);
	assert.equal(settings.circuitBreakerCooldownSeconds, 30);
	assert.equal(settings.circuitBreakerEnabled, true);
	assert.equal(sanitizeDecisionSettings({ mode: "wrapper" }).mode, "wrapper");
	assert.equal(sanitizeDecisionSettings({ timeoutMs: 1500.5 }).timeoutMs, 3000);
	assert.equal(sanitizeDecisionSettings({ timeoutMs: 60_000 }).timeoutMs, 3000);
	assert.equal(sanitizeDecisionSettings({ timeoutMs: 1500 }).timeoutMs, 1500);
});

test("a classifier is pinned only when both provider and model name one", () => {
	const pinned = sanitizeDecisionSettings({ provider: " openrouter ", model: "typesafe/jev-1.13" });
	assert.equal(pinned.provider, "openrouter");
	assert.equal(pinned.model, "typesafe/jev-1.13");
	for (const half of [{ provider: "openrouter" }, { provider: "openrouter", model: "auto" }, { provider: "", model: "x" }]) {
		const settings = sanitizeDecisionSettings(half);
		assert.deepEqual([settings.provider, settings.model], ["auto", "auto"], JSON.stringify(half));
	}
});

test("loadDecisionSettings reads the decision block next to toolExposure", () => {
	const path = settingsFile(
		JSON.stringify({ toolExposure: "deferred", decision: { enabled: true, mode: "wrapper", timeoutMs: 2000 } }),
	);
	assert.equal(loadToolExposureMode(path), "deferred");
	const settings = loadDecisionSettings(path);
	assert.equal(settings.enabled, true);
	assert.equal(settings.mode, "wrapper");
	assert.equal(settings.timeoutMs, 2000);
});

test("saveDecisionSettings keeps toolExposure and keys this version does not know", () => {
	const path = settingsFile(JSON.stringify({ toolExposure: "codemode", future: { keep: true } }));
	const saved = saveDecisionSettings(enabledSettings({ provider: "openrouter", model: "typesafe/jev-1.13" }), path);
	assert.equal(saved.ok, true);
	const written = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(written.toolExposure, "codemode");
	assert.deepEqual(written.future, { keep: true });
	assert.equal(written.decision.enabled, true);
	assert.equal(written.decision.provider, "openrouter");
	assert.equal(written.decision.model, "typesafe/jev-1.13");
	assert.equal(loadDecisionSettings(path).enabled, true);
});

test("saveDecisionSettings refuses to overwrite a corrupt file", () => {
	const path = settingsFile("{ not json");
	const saved = saveDecisionSettings(enabledSettings(), path);
	assert.equal(saved.ok, false);
	assert.equal(readFileSync(path, "utf8"), "{ not json");
});

test("the menu shows every decision field and reads back a pinned classifier", () => {
	const current = enabledSettings({ mode: "wrapper" });
	const items = decisionMenuSections(current, "typesafe/jev-latest").flatMap((section) => section.items);
	assert.deepEqual(
		items.map((item) => item.id),
		["enabled", "mode", "classifier", "timeoutMs", "circuitBreakerEnabled", "circuitBreakerCooldownSeconds"],
	);
	assert.match(items.find((item) => item.id === "classifier")?.hint ?? "", /auto currently uses typesafe\/jev-latest/);

	const next = decisionFromMenuValues(
		{
			enabled: false,
			mode: "classifier-tool",
			classifier: "openrouter/typesafe/jev-1.13",
			timeoutMs: 1500,
			circuitBreakerEnabled: false,
			circuitBreakerCooldownSeconds: 60,
		},
		current,
	);
	assert.deepEqual(next, {
		enabled: false,
		mode: "classifier-tool",
		provider: "openrouter",
		model: "typesafe/jev-1.13",
		timeoutMs: 1500,
		circuitBreakerEnabled: false,
		circuitBreakerCooldownSeconds: 60,
	});
	assert.equal(classifierValue(next), "openrouter/typesafe/jev-1.13");
});

test("menu values of the wrong type keep the current settings, and auto unpins", () => {
	const current = enabledSettings({ provider: "openrouter", model: "typesafe/jev-1.13", timeoutMs: 2000 });
	const next = decisionFromMenuValues({ classifier: "auto", timeoutMs: "fast", enabled: "on" }, current);
	assert.equal(next.enabled, true);
	assert.equal(next.timeoutMs, 2000);
	assert.deepEqual([next.provider, next.model], ["auto", "auto"]);
	assert.equal(classifierValue(next), "auto");
});

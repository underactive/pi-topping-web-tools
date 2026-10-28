import assert from "node:assert/strict";
import { test } from "node:test";
import {
	describeDecision,
	ruleDecision,
	TOOL_CRITERIA,
	TOOL_QUESTION,
	ToolChooser,
	toolQuestions,
	toolState,
} from "../src/decision/choose-tool.ts";
import { enabledSettings, failedResult, fakeRegistry, toolResult } from "./decision-harness.ts";

test("toolQuestions asks one choice question over fetch_markdown and web_browser", () => {
	const questions = toolQuestions();
	assert.deepEqual(Object.keys(questions), [TOOL_QUESTION]);
	const question = questions[TOOL_QUESTION];
	assert.equal(question.type, "choice");
	assert.deepEqual(question.criteria, TOOL_CRITERIA);
	assert.deepEqual(Object.keys(TOOL_CRITERIA).sort(), ["fetch_markdown", "web_browser"]);
});

test("toolState carries the URL and a trimmed, bounded question", () => {
	assert.deepEqual(toolState({ url: "https://example.com/" }), { url: "https://example.com/" });
	assert.deepEqual(toolState({ url: "https://example.com/", question: "   " }), { url: "https://example.com/" });
	assert.deepEqual(toolState({ url: "https://example.com/", question: "  pricing?  " }), {
		url: "https://example.com/",
		question: "pricing?",
	});
	const state = toolState({ url: `https://example.com/${"a".repeat(5000)}`, question: "q".repeat(5000) });
	assert.equal(String(state.url).length, 2000);
	assert.equal(String(state.question).length, 2000);
});

test("ruleDecision answers PDFs, local hosts and bad URLs without a classifier", () => {
	assert.deepEqual(ruleDecision("https://example.com/paper.PDF"), {
		ok: true,
		source: "rule",
		tool: "pdf_extract",
		reason: "the URL path ends in .pdf",
	});
	for (const url of ["http://localhost:3000/", "http://192.168.1.10/app", "file:///tmp/page.html"]) {
		const decision = ruleDecision(url);
		assert.equal(decision?.ok && decision.tool, "web_browser", url);
	}
	assert.equal(ruleDecision("not a url")?.ok, false);
	const ftp = ruleDecision("ftp://example.com/");
	assert.equal(ftp?.ok === false && ftp.reason, "unsupported URL scheme ftp:");
	assert.equal(ruleDecision("https://example.com/docs"), undefined);
});

test("a rule decision never calls the classifier", async () => {
	const registry = fakeRegistry();
	const decision = await new ToolChooser().choose(registry, enabledSettings(), { url: "https://example.com/a.pdf" });
	assert.equal(decision.ok && decision.tool, "pdf_extract");
	assert.equal(registry.calls.length, 0);
});

test("a classifier verdict maps to the recommended tool with confidence and model", async () => {
	const registry = fakeRegistry({ classify: async () => toolResult("web_browser", 0.82) });
	const decision = await new ToolChooser().choose(registry, enabledSettings(), {
		url: "https://app.example.com/dashboard",
		question: "what does the chart show?",
	});
	assert.equal(decision.ok, true);
	assert.ok(decision.ok && decision.source === "classifier");
	assert.equal(decision.tool, "web_browser");
	assert.equal(decision.confidence, 0.82);
	assert.equal(decision.model, "typesafe/jev-latest");
	assert.equal(registry.calls.length, 1);
	assert.deepEqual(registry.calls[0].context.state, {
		url: "https://app.example.com/dashboard",
		question: "what does the chart show?",
	});
	assert.equal(registry.calls[0].options?.timeoutMs, 3000);
	assert.equal(registry.calls[0].options?.maxRetries, 0);
	assert.match(describeDecision(decision), /^Recommended: web_browser \(classifier typesafe\/jev-latest, confidence 82%; fetch_markdown 18%\)\.$/);
});

test("an unknown or missing tool answer is no recommendation", async () => {
	const unknown = fakeRegistry({ classify: async () => toolResult("web_search") });
	const decision = await new ToolChooser().choose(unknown, enabledSettings(), { url: "https://example.com/" });
	assert.deepEqual(decision, { ok: false, reason: "classifier returned web_search", model: "typesafe/jev-latest" });

	const empty = fakeRegistry({ classify: async () => ({ ...toolResult("fetch_markdown"), answers: {} }) });
	const none = await new ToolChooser().choose(empty, enabledSettings(), { url: "https://example.com/" });
	assert.equal(!none.ok && none.reason, "classifier returned no tool answer");
});

test("no credentialed classifier means no recommendation and no call", async () => {
	const registry = fakeRegistry({ configured: [] });
	const decision = await new ToolChooser().choose(registry, enabledSettings(), { url: "https://example.com/" });
	assert.deepEqual(decision, { ok: false, reason: "no classifier model has credentials" });
	assert.equal(registry.calls.length, 0);
});

test("a pinned classifier wins over the auto chain when it has credentials", async () => {
	const registry = fakeRegistry({
		configured: ["typesafe", "openrouter"],
		models: [
			{ provider: "typesafe", id: "jev-latest" },
			{ provider: "openrouter", id: "typesafe/jev-1.13" },
		],
	});
	const pinned = enabledSettings({ provider: "openrouter", model: "typesafe/jev-1.13" });
	await new ToolChooser().choose(registry, pinned, { url: "https://example.com/" });
	await new ToolChooser().choose(registry, enabledSettings(), { url: "https://example.com/" });
	assert.deepEqual(
		registry.calls.map((call) => call.model),
		["openrouter/typesafe/jev-1.13", "typesafe/jev-latest"],
	);
});

test("a timeout opens the circuit for the cooldown, then admits one probe", async () => {
	let now = 0;
	let reply = failedResult("Request timed out");
	const registry = fakeRegistry({ classify: async () => reply });
	const chooser = new ToolChooser(() => now);
	const settings = enabledSettings({ circuitBreakerCooldownSeconds: 30 });
	const request = { url: "https://example.com/" };

	const first = await chooser.choose(registry, settings, request);
	assert.match(!first.ok ? first.reason : "", /^classifier timed out/);
	assert.equal(chooser.breaker.state(), "open");

	now = 29_999;
	const skipped = await chooser.choose(registry, settings, request);
	assert.deepEqual(skipped, { ok: false, reason: "the classifier circuit is open after a timeout" });
	assert.equal(registry.calls.length, 1);

	now = 30_000;
	reply = toolResult("fetch_markdown");
	const probe = await chooser.choose(registry, settings, request);
	assert.equal(probe.ok && probe.tool, "fetch_markdown");
	assert.equal(chooser.breaker.state(), "closed");
	assert.equal(registry.calls.length, 2);
});

test("non-timeout errors never open the circuit", async () => {
	const registry = fakeRegistry({ classify: async () => failedResult("401 unauthorized") });
	const chooser = new ToolChooser(() => 0);
	const decision = await chooser.choose(registry, enabledSettings(), { url: "https://example.com/" });
	assert.equal(!decision.ok && decision.reason, "classifier error: 401 unauthorized");
	assert.equal(chooser.breaker.state(), "closed");
});

test("with the circuit breaker off, timeouts never skip a call", async () => {
	const registry = fakeRegistry({ classify: async () => failedResult("deadline exceeded") });
	const chooser = new ToolChooser(() => 0);
	const settings = enabledSettings({ circuitBreakerEnabled: false });
	await chooser.choose(registry, settings, { url: "https://example.com/" });
	await chooser.choose(registry, settings, { url: "https://example.com/" });
	assert.equal(registry.calls.length, 2);
	assert.equal(chooser.breaker.state(), "closed");
});

test("a registry that throws is reported, never rethrown", async () => {
	const registry = fakeRegistry();
	registry.findOfType = () => {
		throw new Error("catalog exploded");
	};
	const decision = await new ToolChooser().choose(registry, enabledSettings(), { url: "https://example.com/" });
	assert.deepEqual(decision, { ok: false, reason: "catalog exploded" });
});

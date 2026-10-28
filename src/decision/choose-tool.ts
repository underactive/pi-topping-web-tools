/**
 * The tool-selection gate: given a URL and what the caller wants from it, recommend the cheapest
 * adequate web tool. Deterministic rules answer first; otherwise one Jev `choice` question decides
 * between fetch_markdown and web_browser.
 *
 * Contract:
 * - Never throws and never blocks a fetch: every failure is `{ ok: false, reason }`, and the caller
 *   proceeds with its own choice.
 * - The classifier sees the URL and a bounded excerpt of the question, never page content.
 * - A recognised timeout opens the circuit for the configured cooldown; other failures never do.
 */
import type { ClassifierContext, JsonObject } from "@earendil-works/pi-ai";
import {
	CircuitBreaker,
	type ClassifyRegistry,
	choiceAnswer,
	failureReason,
	type JevRegistry,
	preferredClassifier,
	runClassification,
	selectJevModel,
} from "@underactive/pi-topping-primitives/classifier";
import type { DecisionSettings } from "../tool-exposure.ts";
import { isLocalOrPrivateHost, MAX_URL_LENGTH } from "../web-browser/permissions.ts";

export type WebToolName = "fetch_markdown" | "web_browser" | "pdf_extract";
export type ClassifiedTool = "fetch_markdown" | "web_browser";

/** Everything a decision needs from a registry; pi's `ModelRegistry` satisfies it as-is. */
export type DecisionRegistry = JevRegistry & ClassifyRegistry;

export const TOOL_QUESTION = "tool";

export const TOOL_CRITERIA: Record<ClassifiedTool, string> = {
	fetch_markdown:
		"Content that is in the HTML the server returns: documentation sites, READMEs, API references, blog posts, " +
		"articles, wikis, changelogs, release notes, news, forums, and plain-text, JSON, XML or feed responses. " +
		"The question needs only the page's text, not how it looks or behaves.",
	web_browser:
		"Content that needs a real browser: client-rendered single-page apps whose server HTML is an empty shell, " +
		"dashboards and web apps, pages that load content on scroll or behind clicks, forms or logins, and questions " +
		"about screenshots, visual layout, element state, console errors or network requests.",
};

export const TOOL_INSTRUCTIONS =
	"Choose the cheapest web tool that can answer `question` about the page at `url`. fetch_markdown downloads the " +
	"server's HTML and converts it to markdown without running JavaScript; it is fast and cheap. web_browser starts a " +
	"headless Chromium that runs JavaScript and can interact with the page; it is slow and heavy. Prefer fetch_markdown " +
	"unless the site or the question needs a browser.";

const MAX_QUESTION_CHARS = 2000;

export interface ToolRequest {
	url: string;
	/** What the caller wants from the page; optional, and bounded before it is sent. */
	question?: string;
}

export type ToolDecision =
	| { ok: true; source: "rule"; tool: WebToolName; reason: string }
	| {
			ok: true;
			source: "classifier";
			tool: ClassifiedTool;
			confidence: number;
			probabilities: Record<string, number>;
			model: string;
			latencyMs: number;
			cost: number;
	  }
	| { ok: false; reason: string; model?: string };

function isClassifiedTool(value: string): value is ClassifiedTool {
	return value === "fetch_markdown" || value === "web_browser";
}

/** URLs whose tool is already determined, answered without a classifier call. */
export function ruleDecision(url: string): ToolDecision | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { ok: false, reason: "the URL is not a fully-formed URL" };
	}
	if (/\.pdf$/i.test(parsed.pathname)) {
		return { ok: true, source: "rule", tool: "pdf_extract", reason: "the URL path ends in .pdf" };
	}
	if (parsed.protocol === "file:" || isLocalOrPrivateHost(parsed.hostname)) {
		return {
			ok: true,
			source: "rule",
			tool: "web_browser",
			reason: "fetch_markdown reads only public http(s) URLs; local files, localhost and private-network hosts need web_browser",
		};
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false, reason: `unsupported URL scheme ${parsed.protocol}` };
	}
	return undefined;
}

export function toolQuestions(): ClassifierContext["questions"] {
	return {
		[TOOL_QUESTION]: { type: "choice", instructions: TOOL_INSTRUCTIONS, criteria: { ...TOOL_CRITERIA } },
	};
}

export function toolState(request: ToolRequest): JsonObject {
	const state: JsonObject = { url: request.url.slice(0, MAX_URL_LENGTH) };
	const question = request.question?.trim();
	if (question) state.question = question.slice(0, MAX_QUESTION_CHARS);
	return state;
}

/**
 * Holds the circuit breaker across calls, so one instance should live as long as the extension.
 * Settings are passed on every call so a change in `/web-tools-settings` applies at once.
 */
export class ToolChooser {
	#breaker: CircuitBreaker;
	#cooldownMs: number;

	constructor(now: () => number = Date.now) {
		this.#cooldownMs = 0;
		this.#breaker = new CircuitBreaker(() => this.#cooldownMs, now);
	}

	get breaker(): CircuitBreaker {
		return this.#breaker;
	}

	/** Never rejects: a registry that throws is reported like any other failure. */
	async choose(
		registry: DecisionRegistry,
		settings: DecisionSettings,
		request: ToolRequest,
		signal?: AbortSignal,
	): Promise<ToolDecision> {
		try {
			return await this.#choose(registry, settings, request, signal);
		} catch (error) {
			return { ok: false, reason: failureReason(error instanceof Error ? error.message : String(error)) };
		}
	}

	async #choose(
		registry: DecisionRegistry,
		settings: DecisionSettings,
		request: ToolRequest,
		signal: AbortSignal | undefined,
	): Promise<ToolDecision> {
		const rule = ruleDecision(request.url);
		if (rule) return rule;

		const model = selectJevModel(registry, preferredClassifier(settings));
		if (!model) return { ok: false, reason: "no classifier model has credentials" };

		this.#cooldownMs = settings.circuitBreakerCooldownSeconds * 1000;
		const guarded = settings.circuitBreakerEnabled;
		if (!guarded) this.#breaker.reset();
		else if (!this.#breaker.allow()) {
			return { ok: false, reason: "the classifier circuit is open after a timeout" };
		}

		const outcome = await runClassification(
			registry,
			model,
			{ state: toolState(request), questions: toolQuestions() },
			{ signal, timeoutMs: settings.timeoutMs },
		);
		if (!outcome.ok) {
			if (guarded) {
				if (outcome.kind === "timeout") this.#breaker.recordTimeout();
				else this.#breaker.recordFailure();
			}
			const reason =
				outcome.kind === "timeout"
					? `classifier timed out (${outcome.reason})`
					: `classifier ${outcome.kind}: ${outcome.reason}`;
			return { ok: false, reason, model: outcome.model };
		}
		if (guarded) this.#breaker.recordSuccess();

		const answer = choiceAnswer(outcome.answers, TOOL_QUESTION);
		if (!answer || !isClassifiedTool(answer.choice)) {
			return {
				ok: false,
				reason: `classifier returned ${answer ? answer.choice : "no tool answer"}`,
				model: outcome.model,
			};
		}
		return {
			ok: true,
			source: "classifier",
			tool: answer.choice,
			confidence: answer.confidence,
			probabilities: answer.probabilities,
			model: outcome.model,
			latencyMs: outcome.latencyMs,
			cost: outcome.cost,
		};
	}
}

function percent(value: number): string {
	return `${Math.round(value * 100)}%`;
}

/** One line naming the recommendation and where it came from. */
export function describeDecision(decision: ToolDecision): string {
	if (!decision.ok) return `No recommendation: ${decision.reason}.`;
	if (decision.source === "rule") return `Recommended: ${decision.tool} (${decision.reason}).`;
	const others = Object.entries(decision.probabilities)
		.filter(([tool]) => tool !== decision.tool)
		.map(([tool, probability]) => `${tool} ${percent(probability)}`);
	const tail = others.length > 0 ? `; ${others.join(", ")}` : "";
	return `Recommended: ${decision.tool} (classifier ${decision.model}, confidence ${percent(decision.confidence)}${tail}).`;
}

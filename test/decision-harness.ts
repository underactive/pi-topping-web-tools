// Shared helpers for the decision-gate suites. Not a `.test.ts` file, so it is typechecked but not
// run on its own.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	ModelsClassifierOptions,
} from "@earendil-works/pi-ai";
import type { DecisionRegistry } from "../src/decision/choose-tool.ts";
import { DEFAULT_DECISION_SETTINGS, type DecisionSettings } from "../src/tool-exposure.ts";

const jevModel: ClassifierModel<ClassifierApi> = {
	type: "classifier",
	id: "jev-latest",
	name: "Jev",
	api: "typesafe-system-one",
	provider: "typesafe",
	baseUrl: "https://api.typesafe.ai/v1/",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 64_000,
};

export interface FakeRegistryOptions {
	configured?: string[];
	models?: { provider: string; id: string }[];
	classify?: (model: ClassifierModel<ClassifierApi>, context: ClassifierContext) => Promise<ClassifierResult>;
}

export type FakeRegistry = DecisionRegistry & {
	getModelsOfType(type: "classifier"): ClassifierModel<ClassifierApi>[];
	calls: { model: string; context: ClassifierContext; options?: ModelsClassifierOptions }[];
};

/** A registry stub that resolves only the models it is given and records every classify call. */
export function fakeRegistry(options: FakeRegistryOptions = {}): FakeRegistry {
	const configured = new Set(options.configured ?? ["typesafe"]);
	const models = options.models ?? [{ provider: "typesafe", id: "jev-latest" }];
	const calls: FakeRegistry["calls"] = [];
	return {
		calls,
		findOfType: (_type, provider, id) =>
			models.some((model) => model.provider === provider && model.id === id) ? { ...jevModel, provider, id } : undefined,
		getProviderAuthStatus: (provider) => ({ configured: configured.has(provider) }),
		getModelsOfType: () => models.map((model) => ({ ...jevModel, ...model })),
		async classify(model, context, classifyOptions) {
			calls.push({ model: `${model.provider}/${model.id}`, context, options: classifyOptions });
			return options.classify ? options.classify(model, context) : toolResult("fetch_markdown");
		},
	};
}

/** A stopped result whose `tool` answer picks `choice`. */
export function toolResult(choice: string, confidence = 0.87, overrides: Partial<ClassifierResult> = {}): ClassifierResult {
	const other = choice === "web_browser" ? "fetch_markdown" : "web_browser";
	return {
		api: "typesafe-system-one",
		provider: "typesafe",
		model: "jev-1.13.0",
		answers: {
			tool: {
				type: "choice",
				choice,
				confidence,
				probabilities: { [choice]: confidence, [other]: 1 - confidence },
			},
		},
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

export function failedResult(errorMessage: string): ClassifierResult {
	return {
		api: "typesafe-system-one",
		provider: "typesafe",
		model: "jev-1.13.0",
		answers: {},
		stopReason: "error",
		errorMessage,
		timestamp: 1,
	};
}

export function enabledSettings(overrides: Partial<DecisionSettings> = {}): DecisionSettings {
	return { ...DEFAULT_DECISION_SETTINGS, enabled: true, ...overrides };
}

export function settingsFile(body: string): string {
	const dir = join(tmpdir(), `pi-web-tools-decision-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "settings.json");
	writeFileSync(path, body);
	return path;
}

/** Point PI_WEB_TOOLS_SETTINGS_FILE at a fresh file for the duration of `run`. */
export async function withSettingsFile<T>(body: string, run: (path: string) => T | Promise<T>): Promise<T> {
	const previous = process.env.PI_WEB_TOOLS_SETTINGS_FILE;
	const path = settingsFile(body);
	process.env.PI_WEB_TOOLS_SETTINGS_FILE = path;
	try {
		return await run(path);
	} finally {
		if (previous === undefined) delete process.env.PI_WEB_TOOLS_SETTINGS_FILE;
		else process.env.PI_WEB_TOOLS_SETTINGS_FILE = previous;
	}
}

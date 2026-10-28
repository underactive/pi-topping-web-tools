/**
 * `/web-tools-settings`: the decision-gate settings as a primitives menu overlay. The classifier
 * row opens the shared classifier picker, the same one routesense's settings use.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	AUTO_CLASSIFIER,
	availableClassifiers,
	classifierPickerOptions,
	modelName,
	preferredClassifier,
	selectJevModel,
	showClassifierPicker,
} from "@underactive/pi-topping-primitives/classifier";
import { type MenuSection, type MenuValue, showMenu } from "@underactive/pi-topping-primitives/menu";
import {
	DECISION_COOLDOWN_SECONDS_MAX,
	DECISION_MODES,
	DECISION_TIMEOUT_MS_MAX,
	DECISION_TIMEOUT_MS_MIN,
	type DecisionMode,
	type DecisionSettings,
	sanitizeDecisionSettings,
} from "../tool-exposure.ts";

export type DecisionMenuValues = Record<string, MenuValue>;

export const MODE_LABELS: Readonly<Record<DecisionMode, string>> = {
	"classifier-tool": "choose_tool",
	wrapper: "fetch_markdown note",
};

/** `provider/model` for a pinned classifier, else `auto`; the form the picker reads and returns. */
export function classifierValue(settings: Pick<DecisionSettings, "provider" | "model">): string {
	const pinned = preferredClassifier(settings);
	return pinned ? `${pinned.provider}/${pinned.model}` : AUTO_CLASSIFIER;
}

export function decisionMenuSections(settings: DecisionSettings, autoModel: string | undefined): MenuSection[] {
	const autoNote = autoModel ? `auto currently uses ${autoModel}` : "no Jev model has credentials, so auto finds none";
	return [
		{
			title: "Tool-selection gate",
			description:
				"A Jev classifier recommends fetch_markdown, web_browser or pdf_extract for a URL. It needs a credentialed classifier provider, and it sends the URL and question to that provider.",
			items: [
				{
					kind: "toggle",
					id: "enabled",
					label: "Enabled",
					value: settings.enabled,
					hint: "Off: no classifier calls and no choose_tool; the tools behave as without this setting.",
				},
				{
					kind: "cycle",
					id: "mode",
					label: "Mode",
					value: settings.mode,
					values: DECISION_MODES,
					labels: MODE_LABELS,
					hint: "choose_tool: register a tool the model calls before fetching. fetch_markdown note: classify each fetch_markdown call alongside the fetch and append a note when another tool fits better.",
				},
				{
					kind: "pick",
					id: "classifier",
					label: "Classifier model",
					value: classifierValue(settings),
					clearValue: AUTO_CLASSIFIER,
					hint: `Enter lists every classifier model pi has credentials for. Backspace returns to auto, the first configured Jev model; ${autoNote}.`,
				},
				{
					kind: "number",
					id: "timeoutMs",
					label: "Timeout",
					value: settings.timeoutMs,
					min: DECISION_TIMEOUT_MS_MIN,
					max: DECISION_TIMEOUT_MS_MAX,
					presets: [1000, 2000, 3000, 5000, 10000],
					unit: "ms",
					hint: "Longest wait for one classification. A call that runs out gives no recommendation.",
				},
				{
					kind: "toggle",
					id: "circuitBreakerEnabled",
					label: "Circuit breaker",
					value: settings.circuitBreakerEnabled,
					hint: "After a timeout, stop calling the classifier for the cooldown, then allow one probe. Other errors never open it.",
				},
				{
					kind: "number",
					id: "circuitBreakerCooldownSeconds",
					label: "Cooldown",
					value: settings.circuitBreakerCooldownSeconds,
					min: 0,
					max: DECISION_COOLDOWN_SECONDS_MAX,
					presets: [10, 30, 60, 300],
					unit: "s",
					hint: "How long the circuit stays open after a timeout.",
				},
			],
		},
	];
}

/** Menu values over the current settings; a value of the wrong type keeps the current one. */
export function decisionFromMenuValues(values: DecisionMenuValues, current: DecisionSettings): DecisionSettings {
	const pick = <T extends MenuValue>(id: string, fallback: T): T =>
		typeof values[id] === typeof fallback ? (values[id] as T) : fallback;
	const classifier = pick("classifier", classifierValue(current));
	const slash = classifier.indexOf("/");
	const pinned = classifier !== AUTO_CLASSIFIER && slash > 0 && slash < classifier.length - 1;
	return sanitizeDecisionSettings({
		enabled: pick("enabled", current.enabled),
		mode: pick<string>("mode", current.mode),
		provider: pinned ? classifier.slice(0, slash) : AUTO_CLASSIFIER,
		model: pinned ? classifier.slice(slash + 1) : AUTO_CLASSIFIER,
		timeoutMs: pick("timeoutMs", current.timeoutMs),
		circuitBreakerEnabled: pick("circuitBreakerEnabled", current.circuitBreakerEnabled),
		circuitBreakerCooldownSeconds: pick("circuitBreakerCooldownSeconds", current.circuitBreakerCooldownSeconds),
	});
}

/** The applied settings, or undefined when the menu was cancelled or the session has no TUI. */
export async function showDecisionSettings(
	ctx: ExtensionCommandContext,
	current: DecisionSettings,
): Promise<DecisionSettings | undefined> {
	const classifiers = availableClassifiers(ctx.modelRegistry);
	const auto = selectJevModel(ctx.modelRegistry);
	const autoName = auto && modelName(auto);
	const result = await showMenu(ctx, {
		title: "Web Tools: Settings",
		sections: decisionMenuSections(current, autoName),
		buttons: [
			{ id: "apply", label: "Apply", applies: true, primary: true },
			{ id: "cancel", label: "Cancel", closeOnAction: true },
		],
		onPick: async (id, values) => {
			if (id !== "classifier") return undefined;
			const selected = typeof values.classifier === "string" ? values.classifier : AUTO_CLASSIFIER;
			return showClassifierPicker(ctx, {
				title: "Decision classifier",
				options: classifierPickerOptions(classifiers, autoName, selected),
				selected,
			});
		},
	});
	return result.applied ? decisionFromMenuValues(result.values, current) : undefined;
}

/**
 * The optional decision gate: a Jev classifier recommends the cheapest adequate web tool for a URL.
 *
 * - `classifier-tool` mode registers `choose_tool`, which the model calls before fetching.
 * - `wrapper` mode classifies each `fetch_markdown` call alongside the fetch and appends a note to
 *   the result when another tool fits better.
 * - `/web-tools-settings` edits the `decision` block, including the classifier model.
 *
 * Off by default. The gate only recommends: it never blocks or delays a fetch past the fetch's own
 * duration plus the classifier timeout, and every failure leaves the model to choose on its own.
 * This extension loads after fetch_markdown's, so a call its permission prompt blocks is never
 * classified.
 */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { modelName, preferredClassifier, selectJevModel } from "@underactive/pi-topping-primitives/classifier";
import { Type } from "typebox";
import { clipField } from "../render-preview.ts";
import {
	loadDecisionSettings,
	loadWebToolsSettings,
	registerWebTool,
	saveDecisionSettings,
	settingsPath,
	webToolPresentation,
} from "../tool-exposure.ts";
import { describeDecision, type ToolDecision, ToolChooser } from "./choose-tool.ts";
import { classifierValue, MODE_LABELS, showDecisionSettings } from "./settings-menu.ts";

interface ChooseToolDetails {
	decision: ToolDecision;
}

const ChooseToolParams = Type.Object({
	url: Type.String({ description: "The fully-formed URL you are about to read" }),
	question: Type.Optional(
		Type.String({
			description:
				"What you need from the page, for example the user's question. Sent to the classifier with the URL, cut to 2000 characters.",
		}),
	),
});

function nextStep(decision: ToolDecision): string {
	if (!decision.ok) return "Choose between fetch_markdown and web_browser from their descriptions.";
	if (decision.tool === "pdf_extract") return "Call pdf_extract with this URL.";
	if (decision.tool === "fetch_markdown") {
		return "Call fetch_markdown with this URL. If the markdown is empty or missing what you need, fall back to web_browser.";
	}
	if (decision.source === "rule") return "Call web_browser with this URL.";
	return "Call web_browser with this URL. The classifier can be wrong: if you already know the page is static, fetch_markdown is cheaper.";
}

export function chooseToolDefinition(chooser: ToolChooser) {
	return defineTool({
		name: "choose_tool",
		label: "Choose Tool",
		description: `- Recommends the cheapest web tool that can read a URL: fetch_markdown (static HTML), web_browser (JavaScript-rendered or interactive pages), or pdf_extract (PDFs)
- Takes the URL and, optionally, what you need from the page
- Only recommends; it never fetches the URL
- Sends the URL and question to the configured classifier provider, not to the URL's host

Usage notes:
  - Call it before the first fetch of a URL when you cannot tell whether the page needs a browser
  - Skip it when the choice is obvious, for example a known documentation site or a screenshot request
  - When it returns no recommendation, choose from the tool descriptions`,
		promptSnippet: "Recommend fetch_markdown, web_browser or pdf_extract for a URL before fetching it",
		promptGuidelines: [
			"Call choose_tool before the first fetch of an unfamiliar URL when you cannot tell whether it needs a JavaScript-capable browser.",
			"choose_tool only recommends; it does not fetch. Follow its recommendation unless you know a cheaper path.",
		],
		parameters: ChooseToolParams,
		annotations: { readOnlyHint: true, openWorldHint: false },

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const settings = loadDecisionSettings();
			const decision: ToolDecision = settings.enabled
				? await chooser.choose(ctx.modelRegistry, settings, { url: params.url, question: params.question }, signal)
				: { ok: false, reason: "the decision gate is disabled in /web-tools-settings" };
			return {
				content: [{ type: "text", text: `${describeDecision(decision)}\n${nextStep(decision)}` }],
				details: { decision } satisfies ChooseToolDetails,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("choose_tool "));
			try {
				text += theme.fg("accent", new URL(args.url as string).hostname);
			} catch {
				text += theme.fg("accent", clipField(String(args.url)));
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const decision = (result.details as ChooseToolDetails | undefined)?.decision;
			if (!decision) return new Text(theme.fg("muted", "…"), 0, 0);
			if (!decision.ok) return new Text(theme.fg("warning", clipField(`No recommendation: ${decision.reason}`)), 0, 0);
			let text = theme.fg("success", `→ ${decision.tool}`);
			text +=
				decision.source === "rule"
					? theme.fg("muted", ` rule: ${decision.reason}`)
					: theme.fg("muted", ` ${Math.round(decision.confidence * 100)}% · ${decision.model} · ${decision.latencyMs}ms`);
			return new Text(text, 0, 0);
		},
	});
}

/** The note `wrapper` mode appends to a fetch_markdown result, or undefined when fetch_markdown fits. */
export function wrapperNote(decision: ToolDecision): string | undefined {
	if (!decision.ok || decision.tool === "fetch_markdown") return undefined;
	if (decision.source === "rule") return `[decision gate] Use ${decision.tool} for this URL: ${decision.reason}.`;
	return `[decision gate] Classifier ${decision.model} judged this page likely needs a JavaScript-capable browser (confidence ${Math.round(decision.confidence * 100)}%). If the markdown above is empty or missing what you need, retry with web_browser.`;
}

export default function (pi: ExtensionAPI) {
	const chooser = new ToolChooser();
	const tool = chooseToolDefinition(chooser);
	const pending = new Map<string, Promise<ToolDecision>>();
	let registered = false;

	// Tools cannot be unregistered, so a disabled choose_tool is re-registered hidden.
	const syncChooseTool = (): void => {
		const { decision } = loadWebToolsSettings();
		if (decision.enabled && decision.mode === "classifier-tool") {
			registerWebTool(pi, tool);
			registered = true;
		} else if (registered) {
			pi.registerTool({ ...tool, ...webToolPresentation(), exposure: "hidden" });
			registered = false;
		}
	};
	syncChooseTool();

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "fetch_markdown") return undefined;
		const settings = loadDecisionSettings();
		if (!settings.enabled || settings.mode !== "wrapper") return undefined;
		const input = event.input as { url?: unknown; prompt?: unknown; offset?: unknown };
		if (typeof input.url !== "string") return undefined;
		// A later window of a page the model is already reading needs no second opinion.
		if (typeof input.offset === "number" && input.offset > 0) return undefined;
		const question = typeof input.prompt === "string" ? input.prompt : undefined;
		pending.set(event.toolCallId, chooser.choose(ctx.modelRegistry, settings, { url: input.url, question }, ctx.signal));
		return undefined;
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName !== "fetch_markdown") return undefined;
		const decision = pending.get(event.toolCallId);
		if (!decision) return undefined;
		pending.delete(event.toolCallId);
		const note = wrapperNote(await decision);
		if (!note) return undefined;
		return {
			content: [...event.content, { type: "text", text: note }],
			...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
		};
	});

	// A call that another extension blocked never reaches tool_result.
	pi.on("agent_end", () => {
		pending.clear();
	});

	pi.on("session_shutdown", () => {
		pending.clear();
		chooser.breaker.reset();
	});

	pi.registerCommand("web-tools-settings", {
		description: "Configure the web-tools decision gate (classifier-based tool selection)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(`/web-tools-settings needs the interactive TUI. Edit ${settingsPath()} instead.`, "warning");
				return;
			}
			const next = await showDecisionSettings(ctx, loadDecisionSettings());
			if (!next) return;
			const saved = saveDecisionSettings(next);
			if (!saved.ok) {
				ctx.ui.notify(`web-tools settings were not saved: ${saved.message}`, "error");
				return;
			}
			syncChooseTool();
			const decision = saved.value.decision;
			if (!decision.enabled) {
				ctx.ui.notify("Decision gate off.", "info");
				return;
			}
			const model = selectJevModel(ctx.modelRegistry, preferredClassifier(decision));
			const summary = `Decision gate on (${MODE_LABELS[decision.mode]}, classifier ${classifierValue(decision)}).`;
			ctx.ui.notify(
				model
					? `${summary} Using ${modelName(model)}.`
					: `${summary} No classifier model has credentials, so it will give no recommendations.`,
				model ? "info" : "warning",
			);
		},
	});
}

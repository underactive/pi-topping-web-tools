/**
 * Shared ToolExposure + namespace for fetch_markdown, pdf_extract, web_browser and choose_tool,
 * and the settings file they read. Default remains Pi's direct registration with the decision
 * gate off. Other modes are opt-in via settings.json.
 */

import type { ExtensionAPI, ToolDefinition, ToolExposure, ToolNamespace } from "@earendil-works/pi-coding-agent";
import {
	AUTO_CLASSIFIER,
	DEFAULT_CLASSIFIER_CONFIG,
	type JevClassifierConfig,
} from "@underactive/pi-topping-primitives/classifier";
import {
	createSettingsStore,
	sanitize,
	toppingSettingsPath,
	type SettingsWriteResult,
} from "@underactive/pi-topping-primitives/settings";

export type WebToolsExposureMode = "direct" | "codemode" | "deferred";

/** `classifier-tool` registers choose_tool; `wrapper` annotates fetch_markdown results instead. */
export type DecisionMode = "classifier-tool" | "wrapper";
export const DECISION_MODES: readonly DecisionMode[] = ["classifier-tool", "wrapper"];

export const DECISION_TIMEOUT_MS_MIN = 100;
export const DECISION_TIMEOUT_MS_MAX = 30_000;
export const DECISION_COOLDOWN_SECONDS_MAX = 3600;

export interface DecisionSettings extends JevClassifierConfig {
	enabled: boolean;
	mode: DecisionMode;
}

export interface WebToolsSettings {
	toolExposure: WebToolsExposureMode;
	decision: DecisionSettings;
}

/** Off by default: the bundle is keyless, and the gate needs a credentialed classifier provider. */
export const DEFAULT_DECISION_SETTINGS: DecisionSettings = Object.freeze({
	...DEFAULT_CLASSIFIER_CONFIG,
	enabled: false,
	mode: "classifier-tool",
});

export const WEB_TOOLS_NAMESPACE: ToolNamespace = {
	name: "pi-topping-web-tools",
	description: "Keyless fetch_markdown, pdf_extract, and headless web_browser.",
	instructions: [
		"Use fetch_markdown for public HTML documentation, READMEs, and articles when you want turndown markdown and a 15-minute cache.",
		"Use pdf_extract for a remote or local PDF. fetch_markdown and web_fetch cannot read PDF text.",
		"Use web_browser for JavaScript-rendered pages, local servers, screenshots, and interaction.",
		"choose_tool, when the optional decision gate registers it, recommends one of these tools for a URL before you fetch it. It only recommends; it never fetches.",
		"Host allowlist and permission prompts still apply. Exposure only changes how the model sees the tools, not what they may execute.",
		"See the package README sections for fetch_markdown, pdf_extract, and web_browser.",
	].join("\n"),
};

const MAX_SETTINGS_BYTES = 64 * 1024;

const defaultSettingsPath = toppingSettingsPath("pi-topping-web-tools");
const SETTINGS_PATH_ENV = "PI_WEB_TOOLS_SETTINGS_FILE";

/** `PI_WEB_TOOLS_SETTINGS_FILE` wins when non-empty; otherwise the agent-dir default. */
export function settingsPath(): string {
	const override = process.env[SETTINGS_PATH_ENV];
	return override ? override : defaultSettingsPath();
}

export function parseToolExposureMode(value: unknown): WebToolsExposureMode {
	if (value === "codemode" || value === "deferred" || value === "direct") {
		return value;
	}
	return "direct";
}

function classifierName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed && trimmed !== AUTO_CLASSIFIER ? trimmed : undefined;
}

/** Unknown or out-of-range fields fall back to the defaults; a half-pinned classifier reads as auto. */
export function sanitizeDecisionSettings(raw: unknown): DecisionSettings {
	const value = sanitize.isRecord(raw) ? raw : {};
	const defaults = DEFAULT_DECISION_SETTINGS;
	const provider = classifierName(value.provider);
	const model = classifierName(value.model);
	const pinned = provider !== undefined && model !== undefined;
	return {
		enabled: sanitize.booleanOr(value.enabled, defaults.enabled),
		mode: sanitize.enumOr(value.mode, DECISION_MODES, defaults.mode),
		provider: pinned ? provider : AUTO_CLASSIFIER,
		model: pinned ? model : AUTO_CLASSIFIER,
		timeoutMs: sanitize.numberOr(value.timeoutMs, defaults.timeoutMs, {
			min: DECISION_TIMEOUT_MS_MIN,
			max: DECISION_TIMEOUT_MS_MAX,
			integer: true,
		}),
		circuitBreakerEnabled: sanitize.booleanOr(value.circuitBreakerEnabled, defaults.circuitBreakerEnabled),
		circuitBreakerCooldownSeconds: sanitize.numberOr(
			value.circuitBreakerCooldownSeconds,
			defaults.circuitBreakerCooldownSeconds,
			{ min: 0, max: DECISION_COOLDOWN_SECONDS_MAX, integer: true },
		),
	};
}

export function sanitizeWebToolsSettings(raw: unknown): WebToolsSettings {
	const value = sanitize.isRecord(raw) ? raw : {};
	return {
		toolExposure: parseToolExposureMode(value.toolExposure),
		decision: sanitizeDecisionSettings(value.decision),
	};
}

function settingsStore(path?: string) {
	return createSettingsStore<WebToolsSettings>({
		path: path === undefined ? defaultSettingsPath : () => path,
		...(path === undefined ? { pathEnv: SETTINGS_PATH_ENV } : {}),
		maxBytes: MAX_SETTINGS_BYTES,
		codec: { sanitize: sanitizeWebToolsSettings, preserveUnknownKeys: true },
	});
}

/** A missing, oversized or corrupt file means Pi's direct registration and the decision gate off. */
export function loadWebToolsSettings(path?: string): WebToolsSettings {
	return settingsStore(path).read();
}

/** A missing, oversized, corrupt or unrecognised file means Pi's direct registration. */
export function loadToolExposureMode(path?: string): WebToolsExposureMode {
	return loadWebToolsSettings(path).toolExposure;
}

export function loadDecisionSettings(path?: string): DecisionSettings {
	return loadWebToolsSettings(path).decision;
}

/** Locked read-modify-write of the `decision` block; other keys in the file are kept. */
export function saveDecisionSettings(decision: DecisionSettings, path?: string): SettingsWriteResult<WebToolsSettings> {
	return settingsStore(path).update((current) => ({ ...current, decision: sanitizeDecisionSettings(decision) }));
}

export function webToolPresentation(mode: WebToolsExposureMode = loadToolExposureMode()): {
	exposure: ToolExposure;
	namespace: ToolNamespace;
} {
	return {
		exposure: mode,
		namespace: WEB_TOOLS_NAMESPACE,
	};
}

export function registerWebTool(pi: ExtensionAPI, tool: ToolDefinition): void {
	pi.registerTool({ ...tool, ...webToolPresentation() });
}

let didNotifyPrerequisites = false;

export function _resetExposureNoticeForTests(): void {
	didNotifyPrerequisites = false;
}

/** Loader tools that reach tools with this exposure, in the order to activate them. */
function exposureLoaders(mode: WebToolsExposureMode): readonly string[] {
	if (mode === "codemode") return ["codemode"];
	if (mode === "deferred") return ["tool_search", "codemode"];
	return [];
}

/**
 * The registered loader tool to activate so the model can reach the web tools, or undefined when a
 * loader is already active or none is registered. `--tools` and `--exclude-tools` unregister tools,
 * so an excluded loader is never activated.
 */
export function exposureLoaderToActivate(
	mode: WebToolsExposureMode,
	activeTools: readonly string[],
	registeredTools: readonly string[],
): string | undefined {
	const loaders = exposureLoaders(mode);
	if (loaders.some((name) => activeTools.includes(name))) return undefined;
	return loaders.find((name) => registeredTools.includes(name));
}

export function exposurePrerequisiteNotice(
	mode: WebToolsExposureMode,
	activeTools: readonly string[],
): string | undefined {
	if (mode === "direct") return undefined;
	if (exposureLoaders(mode).some((name) => activeTools.includes(name))) return undefined;
	if (mode === "codemode") {
		return 'pi-topping-web-tools toolExposure is "codemode", but the codemode tool is not available, so the model cannot reach the tools. Check --tools and --exclude-tools, or set toolExposure to "direct".';
	}
	return 'pi-topping-web-tools toolExposure is "deferred", but neither tool_search nor codemode is available, so the model cannot reach the tools. Check --tools and --exclude-tools, or set toolExposure to "direct".';
}

/**
 * On every session start, activate the loader tool the configured exposure needs, as Pi's MCP support
 * does for MCP servers. Notify once when no loader can be activated.
 */
export function attachExposureLoader(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const mode = loadToolExposureMode();
		if (mode === "direct") return;
		if (typeof pi.getActiveTools !== "function") return;
		const active = pi.getActiveTools();
		const loader = exposureLoaderToActivate(mode, active, pi.getAllTools().map((tool) => tool.name));
		if (loader) pi.setActiveTools([...active, loader]);
		if (didNotifyPrerequisites) return;
		const message = exposurePrerequisiteNotice(mode, pi.getActiveTools());
		if (!message) return;
		didNotifyPrerequisites = true;
		if (ctx.hasUI) {
			ctx.ui.notify(message, "warning");
		}
	});
}

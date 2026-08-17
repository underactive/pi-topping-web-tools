/**
 * Shared host-permission prompt for web tools.
 *
 * Replaces the duplicated select/session-map logic in fetch_markdown,
 * pdf_extract, and web_browser. Supports durable grants for http/https origins
 * and session-only prompts for file:// origins.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isGranted, addGrant, type PermissionScope, DAY_MS, WEEK_MS, MONTH_MS } from "./permission-store.ts";

export type PermissionPromptResult = { allowed: true } | { allowed: false; reason: string };

type SessionPermissions = Map<string, "allow" | "deny">;

/**
 * Request permission to access a host.
 *
 * Order of checks: session deny → session allow → durable grant → UI prompt.
 *
 * When `durable` is true and UI is available, the prompt includes
 * "Allow for 1 day", "Allow for 1 week", "Allow for 30 days" options.
 * When `durable` is false (e.g. file:// origins), only the original
 * three options are shown.
 */
export async function requestHostPermission(
	ctx: ExtensionContext,
	{
		scope,
		label,
		key,
		sessionPermissions,
		durable,
	}: {
		scope: PermissionScope;
		label: string;
		key: string;
		sessionPermissions: SessionPermissions;
		durable: boolean;
	},
): Promise<PermissionPromptResult> {
	// Session deny
	const sessionDecision = sessionPermissions.get(key);
	if (sessionDecision === "deny") {
		return { allowed: false, reason: `Denied by user for ${key}` };
	}

	// Session allow
	if (sessionDecision === "allow") {
		return { allowed: true };
	}

	// Durable grant
	if (durable && isGranted(scope, key)) {
		return { allowed: true };
	}

	// No UI — block
	if (!ctx.hasUI) {
		return { allowed: false, reason: `${scope} to ${key} blocked (no UI for confirmation)` };
	}

	// Prompt
	const options = durable
		? ["Allow once", "Allow for this session", "Allow for 1 day", "Allow for 1 week", "Allow for 30 days", "Deny"]
		: ["Allow once", "Allow for this session", "Deny"];

	const choice = await ctx.ui.select(label, options);

	if (choice === "Allow for this session") {
		sessionPermissions.set(key, "allow");
		return { allowed: true };
	}

	if (choice === "Allow once") {
		return { allowed: true };
	}

	if (choice === "Deny") {
		sessionPermissions.set(key, "deny");
		return { allowed: false, reason: `Denied by user for ${key}` };
	}

	// Durable duration choices
	let ttlMs: number | undefined;
	if (choice === "Allow for 1 day") ttlMs = DAY_MS;
	else if (choice === "Allow for 1 week") ttlMs = WEEK_MS;
	else if (choice === "Allow for 30 days") ttlMs = MONTH_MS;

	if (ttlMs !== undefined) {
		const persisted = await addGrant(scope, key, ttlMs);
		if (!persisted) {
			// Persist failure — downgrade to session grant.
			sessionPermissions.set(key, "allow");
			ctx.ui.notify(
				`Could not save durable permission; allowing for this session only.`,
				"warning",
			);
		}
		return { allowed: true };
	}

	// Fallback (unexpected choice)
	sessionPermissions.set(key, "deny");
	return { allowed: false, reason: `Denied by user for ${key}` };
}

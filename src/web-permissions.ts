/**
 * /web-permissions — list and revoke saved web-tool host permissions.
 *
 * Shows all active durable grants from the permission store.
 * Users can select entries to revoke them. Bundled preapproved hosts
 * (from the shared allowlist) are not listed and cannot be deleted here.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listGrants, removeGrant, type Grant } from "./permission-store.ts";

function formatRemaining(expiresAt: number): string {
	const ms = expiresAt - Date.now();
	if (ms <= 0) return "expired";
	const hours = Math.floor(ms / (60 * 60 * 1000));
	const days = Math.floor(hours / 24);
	const remHours = hours % 24;
	if (days > 0) return `${days}d ${remHours}h`;
	return `${hours}h`;
}

function formatEntry(grant: Grant): string {
	return `${grant.origin} \u2014 ${grant.scope} \u2014 expires in ${formatRemaining(grant.expiresAt)}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("web-permissions", {
		description: "List and revoke saved web-tool host permissions",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("The /web-permissions command requires an interactive session.", "warning");
				return;
			}

			while (true) {
				const grants = listGrants();

				if (grants.length === 0) {
					ctx.ui.notify(
						"No saved host permissions. Bundled preapproved hosts still apply.",
						"info",
					);
					return;
				}

				grants.sort((a, b) => a.origin.localeCompare(b.origin) || a.scope.localeCompare(b.scope));

				const options = [...grants.map(formatEntry), "Done"];
				const choice = await ctx.ui.select("Saved host permissions:", options);

				if (choice === "Done" || choice === undefined) {
					return;
				}

				// Find the selected grant by matching the formatted entry.
				const index = grants.findIndex((g) => formatEntry(g) === choice);
				if (index === -1) continue;

				const grant = grants[index];
				const confirmed = await ctx.ui.confirm(
					"Remove permission?",
					`${grant.scope} \u2192 ${grant.origin}`,
				);

				if (confirmed) {
					await removeGrant(grant.scope, grant.origin);
					ctx.ui.notify(`Removed permission for ${grant.origin}`, "info");
				}
				// Loop back to show updated list.
			}
		},
	});
}

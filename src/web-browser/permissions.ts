/**
 * URL validation and host permission gating for web_browser.
 *
 * Security model mirrors pi-fetch-markdown-tool: preapproved host allowlist plus
 * per-session user confirmation for other hosts. The allowlist lives in the
 * shared src/permissions.ts module.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isPreapprovedHost } from "../permissions.ts";

export const MAX_URL_LENGTH = 2000;

export function validateURL(url: string): boolean {
	if (url.length > MAX_URL_LENGTH) {
		return false;
	}

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}

	if (parsed.username || parsed.password) {
		return false;
	}

	if (parsed.protocol === "file:") {
		return true;
	}

	const hostname = parsed.hostname;
	const parts = hostname.split(".");
	if (parts.length < 2) {
		const isLocalhost = hostname === "localhost";
		const isIpv6Loopback = hostname === "::1" || hostname === "[::1]";
		if (!isLocalhost && !isIpv6Loopback) {
			return false;
		}
	}

	return parsed.protocol === "http:" || parsed.protocol === "https:";
}

export function isLocalOrPrivateHost(hostname: string): boolean {
	const host =
		hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

	if (host === "localhost" || host === "::1") {
		return true;
	}
	if (host.endsWith(".local")) {
		return true;
	}
	if (/^(fc|fd|fe80:)/i.test(host) || /^::ffff:7f/i.test(host)) {
		return true;
	}

	if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
		return false;
	}

	const octets = host.split(".").map((part) => Number.parseInt(part, 10));
	if (octets.some((n) => n > 255)) {
		return false;
	}

	const [a, b] = octets;
	if (a === 127) return true;
	if (a === 0) return true;
	if (a === 10) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 169 && b === 254) return true;

	return false;
}

export function upgradeHttpToHttps(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.protocol === "http:" && !isLocalOrPrivateHost(parsed.hostname)) {
			parsed.protocol = "https:";
			return parsed.toString();
		}
	} catch {
		// fall through
	}
	return url;
}

export function permissionKey(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.protocol === "file:") {
			return `file://${parsed.pathname}`;
		}
		return `${parsed.protocol}//${parsed.host}`;
	} catch {
		return url;
	}
}

export type PermissionResult = "allow" | `block:${string}`;

export async function checkUrlPermission(
	url: string,
	ctx: ExtensionContext,
	sessionPermissions: Map<string, "allow" | "deny">,
): Promise<PermissionResult> {
	if (!validateURL(url)) {
		return "block:Invalid URL";
	}

	let hostname: string;
	let pathname: string;
	let protocol: string;
	try {
		const parsed = new URL(url);
		hostname = parsed.hostname;
		pathname = parsed.pathname;
		protocol = parsed.protocol;
	} catch {
		return "block:Invalid URL";
	}

	if (protocol !== "file:" && isPreapprovedHost(hostname, pathname)) {
		return "allow";
	}

	const key = permissionKey(url);
	const sessionDecision = sessionPermissions.get(key);
	if (sessionDecision === "allow") {
		return "allow";
	}
	if (sessionDecision === "deny") {
		return `block:Denied by user for ${key}`;
	}

	if (!ctx.hasUI) {
		return `block:web_browser to ${key} blocked (no UI for confirmation)`;
	}

	const label = protocol === "file:" ? `Allow web_browser to local file ${pathname}?` : `Allow web_browser to ${hostname}?`;
	const choice = await ctx.ui.select(label, ["Allow once", "Allow for this session", "Deny"]);

	if (choice === "Allow for this session") {
		sessionPermissions.set(key, "allow");
		return "allow";
	}
	if (choice === "Deny") {
		sessionPermissions.set(key, "deny");
		return `block:Denied by user for ${key}`;
	}
	if (choice === "Allow once") {
		return "allow";
	}

	return `block:Denied by user for ${key}`;
}

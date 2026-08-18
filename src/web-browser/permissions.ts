/**
 * URL validation and host permission gating for web_browser.
 *
 * Security model mirrors pi-fetch-markdown-tool: preapproved host allowlist plus
 * per-session user confirmation for other hosts. The allowlist lives in the
 * shared src/permissions.ts module.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isPreapprovedHost, permissionKey } from "../permissions.ts";
import { requestHostPermission } from "../permission-prompt.ts";

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

function isPrivateIpv4Octets(octets: number[]): boolean {
	if (octets.some((n) => n > 255)) {
		return false;
	}
	const [a, b] = octets;
	return (
		a === 127 ||
		a === 0 ||
		a === 10 ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 169 && b === 254)
	);
}

function mappedIpv4Octets(suffix: string): number[] | undefined {
	// Dotted-quad form: ::ffff:10.0.0.1
	const dotted = /^(\d{1,3}(?:\.\d{1,3}){3})$/.exec(suffix);
	if (dotted) {
		return dotted[1].split(".").map((part) => Number.parseInt(part, 10));
	}
	// Two hex groups form: ::ffff:a00:1
	const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(suffix);
	if (hex) {
		const high = Number.parseInt(hex[1], 16);
		const low = Number.parseInt(hex[2], 16);
		return [high >> 8, high & 0xff, low >> 8, low & 0xff];
	}
	return undefined;
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
	if (/^(fc|fd|fe80:)/i.test(host)) {
		return true;
	}

	const mapped = /^::ffff:(.+)$/i.exec(host);
	if (mapped) {
		const octets = mappedIpv4Octets(mapped[1]);
		if (octets && isPrivateIpv4Octets(octets)) {
			return true;
		}
	}

	if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
		return false;
	}

	return isPrivateIpv4Octets(host.split(".").map((part) => Number.parseInt(part, 10)));
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
	const isDurable = protocol !== "file:";
	const label = isDurable ? `Allow web_browser to ${hostname}?` : `Allow web_browser to local file ${pathname}?`;

	const result = await requestHostPermission(ctx, {
		scope: "web_browser",
		label,
		key,
		sessionPermissions,
		durable: isDurable,
	});

	if (result.allowed) {
		return "allow";
	}
	return `block:${result.reason}`;
}

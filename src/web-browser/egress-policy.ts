import { isIP } from "node:net";
import { isGranted } from "../permission-store.ts";
import { isPreapprovedHost, permissionKey } from "../permissions.ts";

export type EgressDecision = { allow: true } | { allow: false; reason: string };

export type UrlPermissionChecker = (url: string) => boolean;

function denied(reason: string): EgressDecision {
	return { allow: false, reason };
}

function alternateWwwHostname(hostname: string): string | undefined {
	const bareHostname = hostname.startsWith("www.") ? hostname.slice(4) : hostname;
	const unbracketed = bareHostname.startsWith("[") && bareHostname.endsWith("]")
		? bareHostname.slice(1, -1)
		: bareHostname;
	if (
		!bareHostname.includes(".") ||
		bareHostname === "localhost" ||
		bareHostname.endsWith(".local") ||
		isIP(unbracketed) !== 0
	) {
		return undefined;
	}
	return hostname.startsWith("www.") ? bareHostname : `www.${hostname}`;
}

/**
 * Decide whether a browser request may leave the page.
 *
 * HTTP(S) requests require a live URL permission. The network-free internal
 * about:blank page and data/blob subresources are allowed, but top-level
 * data/blob documents are denied. Local-file subresources are allowed only
 * from an approved local-file page;
 * an initial file document instead checks the approved target path.
 */
export function decideRequest(
	requestUrl: string,
	requestResourceType: string,
	pageUrl: string,
	isPermittedUrl: UrlPermissionChecker,
): EgressDecision {
	let request: URL;
	try {
		request = new URL(requestUrl);
	} catch {
		return denied("Invalid request URL");
	}

	if (request.protocol === "http:" || request.protocol === "https:") {
		try {
			return isPermittedUrl(requestUrl)
				? { allow: true }
				: denied(`URL is not approved: ${permissionKey(requestUrl)}`);
		} catch {
			return denied("Permission check failed");
		}
	}

	if (request.href === "about:blank") {
		return { allow: true };
	}

	if (request.protocol === "data:" || request.protocol === "blob:") {
		return requestResourceType === "document"
			? denied(`${request.protocol} document navigation is not allowed`)
			: { allow: true };
	}

	if (request.protocol !== "file:") {
		return denied(`Unsupported request protocol: ${request.protocol}`);
	}

	try {
		if (requestResourceType === "document") {
			return isPermittedUrl(requestUrl)
				? { allow: true }
				: denied(`Local file is not approved: ${permissionKey(requestUrl)}`);
		}

		const page = new URL(pageUrl);
		if (page.protocol !== "file:") {
			return denied("Local-file subrequests require a local-file page");
		}

		return isPermittedUrl(pageUrl)
			? { allow: true }
			: denied(`Local-file page is not approved: ${permissionKey(pageUrl)}`);
	} catch {
		return denied("Permission check failed");
	}
}

/** Build a live checker over preapproved URLs plus session and durable grants. */
export function buildOriginChecker(
	sessionPermissions: Map<string, "allow" | "deny">,
): UrlPermissionChecker {
	return (candidateUrl: string): boolean => {
		let parsed: URL;
		try {
			parsed = new URL(candidateUrl);
		} catch {
			return false;
		}

		if (parsed.username || parsed.password) {
			return false;
		}

		if (parsed.protocol === "ws:") parsed.protocol = "http:";
		else if (parsed.protocol === "wss:") parsed.protocol = "https:";

		if (
			(parsed.protocol === "http:" || parsed.protocol === "https:") &&
			isPreapprovedHost(parsed.hostname, parsed.pathname)
		) {
			return true;
		}

		if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "file:") {
			return false;
		}

		const key = permissionKey(parsed.toString());
		const sessionDecision = sessionPermissions.get(key);
		if (sessionDecision === "deny") return false;
		if (sessionDecision === "allow") return true;
		if (parsed.protocol !== "file:" && isGranted("web_browser", key)) return true;

		if (parsed.protocol === "http:" || parsed.protocol === "https:") {
			const alternateHostname = alternateWwwHostname(parsed.hostname);
			if (alternateHostname) {
				const alternateUrl = new URL(parsed.toString());
				alternateUrl.hostname = alternateHostname;
				const alternateKey = permissionKey(alternateUrl.toString());
				const alternateDecision = sessionPermissions.get(alternateKey);
				if (alternateDecision === "deny") return false;
				if (alternateDecision === "allow") return true;
				if (isGranted("web_browser", alternateKey)) return true;
			}
		}

		return false;
	};
}

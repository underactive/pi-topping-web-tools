import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const BROWSER_FEED_TYPE = "pi-topping-web-tools/browser";

export interface BrowserFeedPayload {
	label: string;
	open: 0 | 1;
}

let extension: ExtensionAPI | undefined;
let latestPayload: BrowserFeedPayload | undefined;
let emittedPayload: BrowserFeedPayload | undefined;
let publishAfterFirstTurn = false;

function samePayload(left: BrowserFeedPayload | undefined, right: BrowserFeedPayload): boolean {
	return left?.label === right.label && left.open === right.open;
}

function emitBrowserState(force = false): void {
	if (!extension || !latestPayload || (!force && samePayload(emittedPayload, latestPayload))) return;
	try {
		extension.appendEntry(BROWSER_FEED_TYPE, latestPayload);
		emittedPayload = latestPayload;
	} catch {
		// Feed publication is best effort; leave emitted state unchanged for retry.
	}
}

export function registerBrowserFeeds(pi: ExtensionAPI): void {
	extension = pi;
	pi.on("session_start", () => {
		emittedPayload = undefined;
		publishAfterFirstTurn = true;
	});
	pi.on("turn_end", () => {
		if (!publishAfterFirstTurn) return;
		publishAfterFirstTurn = false;
		emitBrowserState(true);
	});
}

export function publishBrowserState(label: string, open: boolean | number): void {
	latestPayload = { label, open: open ? 1 : 0 };
	emitBrowserState();
}

export function resetBrowserFeedState(): void {
	extension = undefined;
	latestPayload = undefined;
	emittedPayload = undefined;
	publishAfterFirstTurn = false;
}

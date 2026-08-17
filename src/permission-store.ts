/**
 * Durable permission store for web tools.
 *
 * Persists user-approved host grants to a JSON file in the agent config
 * directory. Grants expire after their TTL and are pruned on read/write.
 * Storage is global (not cwd-scoped) so cwd-scoped write tools cannot reach it.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { permissionKey } from "./permissions.ts";

export type PermissionScope = "fetch_markdown" | "pdf_extract" | "web_browser";

export type Grant = {
	scope: PermissionScope;
	origin: string;
	grantedAt: number;
	expiresAt: number;
};

type StoreFile = {
	version: 1;
	grants: Grant[];
};

export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;
export const MONTH_MS = 30 * DAY_MS;

const MAX_FILE_BYTES = 1024 * 1024; // 1 MB
const MAX_GRANTS = 500;
const LOCK_RETRY_MS = 50;
const LOCK_RETRIES = 20; // ~1 s total
const LOCK_STALE_MS = 10_000;

function storePath(): string {
	return process.env.PI_WEB_TOOLS_PERMISSIONS_FILE ?? join(getAgentDir(), "web-permissions.json");
}

function lockPath(): string {
	return `${storePath()}.lock`;
}

function normalizeOrigin(origin: string): string {
	// Round-trip through permissionKey to enforce consistent format.
	return permissionKey(origin);
}

function isValidScope(scope: string): scope is PermissionScope {
	return scope === "fetch_markdown" || scope === "pdf_extract" || scope === "web_browser";
}

function validateGrant(entry: unknown): entry is Grant {
	if (typeof entry !== "object" || entry === null) return false;
	const g = entry as Record<string, unknown>;
	if (!isValidScope(g.scope as string)) return false;
	if (typeof g.origin !== "string") return false;
	if (typeof g.grantedAt !== "number" || !Number.isFinite(g.grantedAt)) return false;
	if (typeof g.expiresAt !== "number" || !Number.isFinite(g.expiresAt)) return false;
	if (g.expiresAt <= Date.now()) return false; // expired
	if (normalizeOrigin(g.origin as string) !== g.origin) return false; // malformed origin
	return true;
}

/** Read and validate the store file. Returns empty list on any parse/validation failure. */
export function listGrants(): Grant[] {
	let raw: string;
	try {
		raw = readFileSync(storePath(), "utf-8");
	} catch {
		return [];
	}

	if (Buffer.byteLength(raw) > MAX_FILE_BYTES) {
		return [];
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}

	if (typeof parsed !== "object" || parsed === null) return [];
	const file = parsed as StoreFile;
	if (file.version !== 1 || !Array.isArray(file.grants)) return [];

	const now = Date.now();
	const valid: Grant[] = [];
	for (const entry of file.grants) {
		if (typeof entry !== "object" || entry === null) continue;
		const g = entry as Record<string, unknown>;
		if (!isValidScope(g.scope as string)) continue;
		if (typeof g.origin !== "string") continue;
		if (typeof g.grantedAt !== "number" || !Number.isFinite(g.grantedAt)) continue;
		if (typeof g.expiresAt !== "number" || !Number.isFinite(g.expiresAt)) continue;
		if (g.expiresAt <= now) continue; // expired
		if (normalizeOrigin(g.origin as string) !== g.origin) continue; // malformed
		valid.push({
			scope: g.scope as PermissionScope,
			origin: g.origin as string,
			grantedAt: g.grantedAt as number,
			expiresAt: g.expiresAt as number,
		});
	}

	return valid;
}

/** Check whether a specific scope+origin has an active durable grant. */
export function isGranted(scope: PermissionScope, origin: string): boolean {
	const key = normalizeOrigin(origin);
	return listGrants().some((g) => g.scope === scope && g.origin === key);
}

/** Prune expired entries from a grant list. */
function pruneExpired(grants: Grant[]): Grant[] {
	const now = Date.now();
	return grants.filter((g) => g.expiresAt > now);
}

/** Attempt to acquire a lock file. Returns true if acquired. */
async function acquireLock(): Promise<boolean> {
	const lp = lockPath();
	for (let i = 0; i < LOCK_RETRIES; i++) {
		try {
			// wx fails if the file already exists.
			await writeFile(lp, String(process.pid), { flag: "wx" });
			return true;
		} catch {
			// Check for stale lock.
			try {
				const { mtimeMs } = await stat(lp);
				if (Date.now() - mtimeMs > LOCK_STALE_MS) {
					// Stale lock — take it over.
					await writeFile(lp, String(process.pid), { flag: "w" });
					return true;
				}
			} catch {
				// Lock file disappeared between check and stat — retry.
			}
			await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
		}
	}
	return false;
}

async function releaseLock(): Promise<void> {
	try {
		await unlink(lockPath());
	} catch {
		// ignore
	}
}

async function writeStore(grants: Grant[]): Promise<void> {
	const dir = join(storePath(), "..");
	await mkdir(dir, { recursive: true });

	const file: StoreFile = { version: 1, grants };
	const tmp = `${storePath()}.tmp`;
	await writeFile(tmp, JSON.stringify(file, null, "\t"), { mode: 0o600 });
	await rename(tmp, storePath());
}

/** Add a durable grant. Returns false if the lock could not be acquired. */
export async function addGrant(scope: PermissionScope, origin: string, ttlMs: number): Promise<boolean> {
	const normalized = normalizeOrigin(origin);
	const locked = await acquireLock();
	if (!locked) return false;

	try {
		const grants = pruneExpired(listGrants());

		// Remove existing grant for same scope+origin.
		const filtered = grants.filter((g) => !(g.scope === scope && g.origin === normalized));

		const now = Date.now();
		filtered.push({
			scope,
			origin: normalized,
			grantedAt: now,
			expiresAt: now + Math.min(ttlMs, MONTH_MS),
		});

		// Cap at MAX_GRANTS.
		const capped = filtered.length > MAX_GRANTS ? filtered.slice(-MAX_GRANTS) : filtered;
		await writeStore(capped);
		return true;
	} finally {
		await releaseLock();
	}
}

/** Remove a durable grant. Returns false if the lock could not be acquired. */
export async function removeGrant(scope: PermissionScope, origin: string): Promise<boolean> {
	const normalized = normalizeOrigin(origin);
	const locked = await acquireLock();
	if (!locked) return false;

	try {
		const grants = pruneExpired(listGrants());
		const filtered = grants.filter((g) => !(g.scope === scope && g.origin === normalized));
		await writeStore(filtered);
		return true;
	} finally {
		await releaseLock();
	}
}

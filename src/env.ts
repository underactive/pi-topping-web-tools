// Same truthiness rules as pi core's isTruthyEnvFlag.
export function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/** Set when pi suppresses non-essential notifications. */
export function suppressNotifications(env: NodeJS.ProcessEnv = process.env): boolean {
	return isTruthyEnvFlag(env.PI_SUPPRESS_NOTIFICATIONS);
}

export function combineSignals(
	userSignal: AbortSignal | undefined,
	timeoutMs: number,
	activeFetches: Set<AbortController>,
): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	// Register so the caller's cleanup can abort this request during shutdown/reload.
	activeFetches.add(controller);
	const signals: AbortSignal[] = [controller.signal, AbortSignal.timeout(timeoutMs)];
	if (userSignal) signals.push(userSignal);
	return {
		signal: AbortSignal.any(signals),
		cleanup: () => {
			activeFetches.delete(controller);
		},
	};
}

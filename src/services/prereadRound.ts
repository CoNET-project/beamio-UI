/**
 * The pre-read round in flight (option A; the decision ②: one native pre-read round at a time).
 * Kept in its own module so that the start-up retry in App and the pre-read in nativeRecovery share one state.
 * `beginPrereadRound` opens a round and returns its conclude function; `nativePrereadRoundInFlight` resolves when the open round concludes.
 */
let inFlight: Promise<void> | null = null

export function beginPrereadRound(): () => void {
	let conclude!: () => void
	inFlight = new Promise<void>((resolve) => {
		conclude = resolve
	})
	const round = inFlight
	return () => {
		if (inFlight === round) inFlight = null
		conclude()
	}
}

/** The open round's conclusion, or null when no pre-read round is open. */
export function nativePrereadRoundInFlight(): Promise<void> | null {
	return inFlight
}

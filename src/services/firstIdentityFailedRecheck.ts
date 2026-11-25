/**
 * After a `failed` first-identity status (0.53.52). The SDK latches `failed` for the rest of the process (the event is not sent again), but it keeps
 * retrying in the same process on its own ladder; a retry that succeeds sends NO `registered` event. So the page, while it shows the failed notice, reads
 * identityPublic again at a low rate (never faster than FIRST_IDENTITY_FAILED_RECHECK_MS) and, as soon as the identity is ready, leaves the failed
 * notice and starts the chat. It watches the setup state itself: it starts when the state becomes `failed` and stops when it becomes anything else.
 */
import { getFirstIdentitySetup, subscribeFirstIdentitySetup } from './shellFirstIdentitySetup'

/** The lowest rate of the re-read while the failed notice is shown: one read per minute at most. */
export const FIRST_IDENTITY_FAILED_RECHECK_MS = 60_000

export type FailedRecheckDeps = {
	/** true when identityPublic answers that the chat identity is ready */
	readReady: () => Promise<boolean>
	/** called once when it is ready (the caller leaves the failed notice and starts the chat) */
	onReady: () => void
	intervalMs?: number
	log?: (message: string) => void
}

/** Watches the first-identity setup state; returns the stop function. */
export function watchFirstIdentityFailed(deps: FailedRecheckDeps): () => void {
	const every = Math.max(deps.intervalMs ?? FIRST_IDENTITY_FAILED_RECHECK_MS, FIRST_IDENTITY_FAILED_RECHECK_MS)
	let timer: ReturnType<typeof setTimeout> | undefined
	let inFlight = false
	const stop = (): void => {
		if (timer !== undefined) clearTimeout(timer)
		timer = undefined
	}
	const schedule = (): void => {
		stop()
		timer = setTimeout(() => void tick(), every)
	}
	const tick = async (): Promise<void> => {
		timer = undefined
		if (getFirstIdentitySetup() !== 'failed') return
		if (inFlight) return schedule()
		inFlight = true
		let ready = false
		try {
			ready = await deps.readReady()
		} catch {
			ready = false
		}
		inFlight = false
		// the state may have changed while the read ran
		if (getFirstIdentitySetup() !== 'failed') return
		if (ready) {
			deps.log?.('first identity: identityPublic reads the identity ready after a failed status: the chat starts')
			deps.onReady()
			return
		}
		schedule()
	}
	const unsubscribe = subscribeFirstIdentitySetup((v) => {
		if (v === 'failed') {
			if (timer === undefined && !inFlight) schedule()
		} else stop()
	})
	if (getFirstIdentitySetup() === 'failed') schedule()
	return () => {
		stop()
		unsubscribe()
	}
}

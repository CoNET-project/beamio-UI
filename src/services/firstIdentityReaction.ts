/**
 * What the page does with a firstIdentityStatus event (frozen protocol v1 §4). Pure logic with injected effects, so the rules are tested without
 * the chat module. The page never sends a create command because of an event.
 */
import type { FirstIdentityStatus } from './firstIdentityStatus'
import type { FirstIdentitySetup } from './shellFirstIdentitySetup'

export const FIRST_IDENTITY_RETRY_MIN_MS = 1_000
export const FIRST_IDENTITY_RETRY_MAX_MS = 300_000

export type FirstIdentityReactionDeps = {
	setSetup: (v: FirstIdentitySetup) => void
	/** the page's own cap: counts one retry; 'stop' at the limit */
	capFailed: () => 'retry' | 'stop'
	/** the page's own ladder delay for the current count */
	ladderDelayMs: () => number
	setTimer: (delayMs: number, fn: () => void) => void
	clearTimer: () => void
	hasTimer: () => boolean
	/** reads identityPublic again through the normal start */
	startNow: () => void
	showPending: () => void
	retryExhausted: () => void
	log: (message: string) => void
}

export function createFirstIdentityReaction(d: FirstIdentityReactionDeps): (s: FirstIdentityStatus) => void {
	return (s) => {
		d.log(`shell chat: first identity status ${s.state}${s.reason ? ` (${s.reason})` : ''}`)
		if (s.state === 'registering') {
			d.setSetup('setting_up')
			return
		}
		if (s.state === 'retry_later') {
			d.setSetup('setting_up')
			if (d.hasTimer()) return
			if (d.capFailed() === 'stop') {
				d.setSetup('idle')
				d.retryExhausted()
				return
			}
			const delay = typeof s.retryAfterMs === 'number' ? Math.min(Math.max(s.retryAfterMs, FIRST_IDENTITY_RETRY_MIN_MS), FIRST_IDENTITY_RETRY_MAX_MS) : d.ladderDelayMs()
			d.setTimer(delay, d.startNow)
			return
		}
		d.clearTimer()
		if (s.state === 'registered') {
			d.setSetup('idle')
			d.startNow()
			return
		}
		if (s.state === 'identity_pending') {
			d.setSetup('idle')
			d.showPending()
			return
		}
		d.setSetup('failed')
	}
}

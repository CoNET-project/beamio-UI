/**
 * What a "native wallet not ready" surface shows while the shell has not answered hello:
 * - inside the 180 s window (a request is in flight or the window has not run out): "preparing the wallet", no "not ready" text;
 * - after it, with no valid answer: the "try later" text with the retry button, and a read-only poll every 30 s while the surface is visible and
 *   the app is in the foreground (it only asks again; it writes and generates nothing).
 * A valid answer ends it (the capability status changes and the surface goes away on its own).
 */
import { useEffect, useState } from 'react'
import { helloWithinWindow, onHelloValid } from '../services/nativeChatRouteRegister'
import { requestNativeIdentityRetry } from '../services/nativeIdentityProbeRetry'

export const HELLO_POLL_MS = 30_000

export function useHelloWindowOpen(): boolean {
	const [open, setOpen] = useState(() => helloWithinWindow())
	useEffect(() => {
		const tick = () => setOpen(helloWithinWindow())
		tick()
		const id = window.setInterval(tick, 5_000)
		const off = onHelloValid(tick)
		return () => {
			window.clearInterval(id)
			off()
		}
	}, [])
	return open
}

/** While `active` (the surface is shown), asks again every 30 s when the page is visible. A hidden page does not poll. */
export function useVisibleReadPoll(active: boolean, intervalMs: number = HELLO_POLL_MS, ask: () => void = requestNativeIdentityRetry): void {
	useEffect(() => {
		if (!active) return
		const id = window.setInterval(() => {
			if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
			ask()
		}, intervalMs)
		return () => window.clearInterval(id)
	}, [active, intervalMs, ask])
}

/**
 * QA boot markers (coordinator request, 2026-11-16). They let the real-device QA read the screen and the sync events from the log,
 * since a devicectl screenshot is not available on the test rig:
 *   [BeamioBoot] screen=splash|onboarding|home launch=<n> t=<ms>
 *   [BeamioBoot] sync=send|reply|retry seq=<n> launch=<n> t=<ms>
 * Printed only in a build with REACT_APP_BEAMIO_BOOT_TRACE=true (the QA build scripts set it; a Release build does not). A line carries
 * the screen name or the sync event, the launch number, the sequence number and a monotonic time. It never carries a mnemonic,
 * an EOA or any key material.
 */
import { publishNativePwaLog } from '@/utils/cashTreesNativePwaLog'

export type BootScreen = 'splash' | 'onboarding' | 'home'
export type BootSyncEvent = 'send' | 'reply' | 'retry'

const LAUNCH_KEY = 'beamio.boot.launch'
let launch: number | null = null

/** The launch number: one per page start in this tab (kept in sessionStorage); 1 when the store is unavailable. */
export function bootLaunchNumber(): number {
	if (launch !== null) return launch
	let n = 1
	try {
		n = (Number(window.sessionStorage.getItem(LAUNCH_KEY)) || 0) + 1
		window.sessionStorage.setItem(LAUNCH_KEY, String(n))
	} catch {
		n = 1
	}
	launch = n
	return n
}

const monotonicMs = (): number => Math.round(performance.now())

// The switch is written inline (not behind a helper) so that a Release build folds the whole branch away, marker strings included.
export function markBootScreen(screen: BootScreen): void {
	if (process.env.REACT_APP_BEAMIO_BOOT_TRACE === 'true') {
		publishNativePwaLog('info', `[BeamioBoot] screen=${screen} launch=${bootLaunchNumber()} t=${monotonicMs()}`)
	}
}

export function markBootSync(event: BootSyncEvent, seq: number): void {
	if (process.env.REACT_APP_BEAMIO_BOOT_TRACE === 'true') {
		publishNativePwaLog('info', `[BeamioBoot] sync=${event} seq=${seq} launch=${bootLaunchNumber()} t=${monotonicMs()}`)
	}
}

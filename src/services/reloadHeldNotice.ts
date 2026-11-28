/**
 * a reload the user asked for with a button is held while a chat write is in progress or a message exists only in memory (chatWriteLock.ts). The tap must not do nothing:
 * this module shows a toast that says why and what to do. It runs once at start (index.tsx). Three copies: saving (wait, the page refreshes by itself when it is done), queue (messages are waiting to be sent; the page refreshes once they are sent) and unsaved (a message is
 * not saved: Retry it; the page refreshes once it is saved).
 */
import { onUserReloadHeld, reloadHoldAwaitingStatus, reloadHoldFirmStatus, reloadHoldSoftKind, reloadHoldView, type ReloadHoldReason, type ReloadHoldView } from './chatWriteLock'
import type { AwaitingStatus } from './reloadHoldPolicy'
import { showBeamioToast } from '@/locale/beamioToast'
import { tu } from '@/locale/beamioLocale'

/**
 * the awaiting copy follows the wait (30 s, 4 min) but it only INFORMS: there is no tap-again override and no automatic refresh behind any of the three lines. The wording of the two newer lines (zh-CN and en) is
 * a draft.
 */
export const reloadHeldCopyKey = (reason: ReloadHoldReason, status: AwaitingStatus = 'waiting', soft: 'awaiting' | 'confirmed' | 'none' = 'awaiting', firmStatus: AwaitingStatus = 'waiting'): string =>
	// a hold that is only items whose receipt is in (the local copy / backup is pending) must not say "awaiting confirmation"
	reason === 'awaiting' && soft === 'confirmed' ? 'chat.reload.held_backup'
		: reason === 'unsaved' ? 'chat.reload.held_unsaved'
		: reason === 'queue' ? (firmStatus === 'long_wait' ? 'chat.reload.held_failed_long' : firmStatus === 'still_waiting' ? 'chat.reload.held_failed_30s' : 'chat.reload.held_failed')
			: reason === 'awaiting' ? (status === 'long_wait' ? 'chat.reload.held_awaiting_long' : status === 'still_waiting' ? 'chat.reload.held_awaiting_30s' : 'chat.reload.held_awaiting')
				: 'chat.reload.held_saving'

let installed = false
export function installReloadHeldNotice(): void {
	if (installed) return
	installed = true
	onUserReloadHeld((reason) => showBeamioToast(tu(reloadHeldCopyKey(reason, reloadHoldAwaitingStatus(), reloadHoldSoftKind(), reloadHoldFirmStatus()), { count: reloadHoldView().count })))
}

/** The key and the count of the standing status line for a hold view (ReloadHoldStatus.tsx); null when nothing is held. */
export function reloadHoldStatusOf(view: ReloadHoldView): { key: string; count: number } | null {
	if (!view.held || view.reason === null) return null
	return { key: reloadHeldCopyKey(view.reason, view.awaitingStatus, view.soft, view.firmStatus), count: view.count }
}

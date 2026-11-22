/**
 *a visible, retryable note on the home when the page-to-shell sync did not finish. It never clears local data and never blocks the
 * home. The retry re-reads the page's valid mnemonic and syncs again (registered by the gate).
 */
import React, { useEffect, useState } from 'react'
import { tu } from '@/locale/beamioLocale'
import { checkShellManualRetry, retryShellSync, useShellSyncState } from '@/services/shellSyncStatus'
import { retryPersist, usePersistNoticeFailed } from '@/services/persistNoticeStatus'

function ShellSyncBody() {
	const state = useShellSyncState()
	// a held write (rollback_pending) shows its button only after the live check (read before rendering).
	const heldWrite = state.kind === 'failed' && state.code === 'write_failed' && state.reason === 'rollback_pending'
	const [manualAllowed, setManualAllowed] = useState(false)
	useEffect(() => {
		if (!heldWrite) return
		let alive = true
		void checkShellManualRetry().then((ok) => {
			if (alive) setManualAllowed(ok)
		})
		return () => {
			alive = false
		}
	}, [heldWrite, state])
	if (state.kind !== 'failed') return null
	// old_copy_unverified: the old copy could not be verified; nothing is overwritten. Explanation only, no retry button.
	const oldCopy = state.code === 'write_failed' && state.reason === 'old_copy_unverified'
	if (oldCopy) {
		return (
			<div role="status" className="mx-4 mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
				<div className="font-semibold">{tu('shell_sync_failed_title')}</div>
				<div className="mt-1">{tu('shell_sync_old_copy_unverified_body')}</div>
			</div>
		)
	}
	// locked (HC-LOCK L-SYNC): the native lock. Explanation only, non-blocking, no automatic or manual retry here (the unlock re-runs the sync).
	if (state.code === 'locked') {
		return (
			<div role="status" className="mx-4 mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
				<div className="font-semibold">{tu('shell_sync_native_locked_title')}</div>
				<div className="mt-1">{tu('shell_sync_native_locked_body')}</div>
			</div>
		)
	}
	return (
		<div role="status" className="mx-4 mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
			<div className="font-semibold">{tu(state.code === 'write_failed' ? 'shell_sync_native_unavailable_title' : 'shell_sync_failed_title')}</div>
			<div className="mt-1">
				{tu(
					state.code === 'write_failed'
						? 'shell_sync_native_unavailable_body'
						: state.retryable
							? 'shell_sync_failed_body'
							: 'shell_sync_refused_body',
				)}
			</div>
			{state.retryable && (!heldWrite || manualAllowed) ? (
				<button
					type="button"
					className="mt-2 rounded-lg bg-amber-600 px-3 py-1 text-white"
					onClick={() => {
						retryShellSync()
					}}
				>
					{tu('shell_sync_retry_action')}
				</button>
			) : null}
		</div>
	)
}

/**
 * 0.53.39: a save that did not complete shows here (the same position as the sync notice). The data on disk is
 * unchanged; the button runs the save again. No new page.
 */
export default function ShellSyncNotice() {
	const persistFailed = usePersistNoticeFailed()
	return (
		<>
			{persistFailed && (
				<div role="status" className="mx-4 mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
					<div className="font-semibold">{tu('persist_save_not_completed')}</div>
					<button
						type="button"
						className="mt-2 rounded-lg bg-amber-600 px-3 py-1 text-white"
						onClick={() => {
							retryPersist()
						}}
					>
						{tu('persist_retry_action')}
					</button>
				</div>
			)}
			<ShellSyncBody />
		</>
	)
}


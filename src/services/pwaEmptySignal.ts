/**
 * `pwaEmptySignal` — page → shell, after IndexedDB confirms there is no mnemonic of any form.
 *
 * Wire: `{ type: 'pwaEmptySignal', reqId, seq, pwaState: 'explicit_empty' }` (shell sets trustedOrigin).
 * `seq` comes from the shared `nextShellTxSeq` used by `pwaWalletSync`.
 *
 * Send only when the page mnemonic field is `absent` (no phrase, no envelope, no other shape).
 * Unreadable storage, an envelope, a plaintext phrase, or any other shape → do not send.
 * The SDK discard switch stays off by default; this signal alone does not delete native material.
 */
import { sendShellWalletSyncCommand, shellRecordTransportKind } from './shellRecordTransport'
import { pwaWalletSyncReqIdFor } from './reqIdSpaces'
import { nextShellTxSeq } from './shellTxSeq'
import { pageMnemonicField } from './pageMnemonicField'
import { isShellContext } from './shellContext'
import { publishNativePwaLog } from '@/utils/cashTreesNativePwaLog'

export const PWA_EMPTY_SIGNAL_TYPE = 'pwaEmptySignal' as const
export const PWA_EMPTY_SIGNAL_STATE = 'explicit_empty' as const

export type PwaEmptySignalOutcome = 'sent' | 'skipped' | 'unavailable'

function transportAvailable(): boolean {
	const kind = shellRecordTransportKind()
	return kind === 'window' || kind === 'chat'
}

/**
 * Returns true only when the loaded (or empty) page record has no mnemonic field of any form.
 * `null` / unreadable → false (do not send). Empty store → true (absent).
 */
export function pageRecordIsExplicitEmptyMnemonic(data: unknown | null | undefined, storageStatus: 'loaded' | 'empty' | 'unavailable' | 'locked' | string): boolean {
	if (storageStatus === 'unavailable' || storageStatus === 'locked') return false
	if (storageStatus === 'empty') return true
	if (storageStatus !== 'loaded') return false
	return pageMnemonicField(data).kind === 'absent'
}

/**
 * Fire-and-forget: when the page is an explicit empty (no mnemonic of any form), send one `pwaEmptySignal`.
 * Never throws. Callers may ignore the outcome.
 */
export async function sendPwaEmptySignalIfExplicitEmpty(input: {
	storageStatus: 'loaded' | 'empty' | 'unavailable' | 'locked' | string
	data?: unknown | null
}): Promise<PwaEmptySignalOutcome> {
	if (!isShellContext() || !transportAvailable()) return 'unavailable'
	if (!pageRecordIsExplicitEmptyMnemonic(input.data, input.storageStatus)) return 'skipped'
	const seq = nextShellTxSeq()
	const reqId = pwaWalletSyncReqIdFor(seq)
	const cmd = {
		type: PWA_EMPTY_SIGNAL_TYPE,
		reqId,
		seq,
		pwaState: PWA_EMPTY_SIGNAL_STATE,
	}
	try {
		const answer = await sendShellWalletSyncCommand(cmd)
		if (answer.kind === 'payload') {
			publishNativePwaLog('info', `[pwaEmptySignal] sent seq=${seq} pwaState=${PWA_EMPTY_SIGNAL_STATE}`)
			return 'sent'
		}
		publishNativePwaLog('warn', `[pwaEmptySignal] transport ${answer.kind}: not confirmed`)
		return 'unavailable'
	} catch {
		publishNativePwaLog('warn', '[pwaEmptySignal] send failed')
		return 'unavailable'
	}
}

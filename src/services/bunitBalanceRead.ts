/**
 * B-Unit balance read with a fallback and three states.
 *
 * A valid answer is either a value or a valid zero: both are `ok`. A failure (the API and the RPC both failed, or a stalled read ran
 * past its bound) is `unavailable`. A failure is never reported as zero, so the screens can show "unavailable" instead of 0.
 * The API read is bounded at 12 s; when it does not answer, the CoNET RPC is read, also bounded at 12 s.
 */
import { abortAfter, BOOT_REQUEST_TIMEOUT_MS, withBootTimeout } from '@/utils/bootTimeout'

export type BUnitBalance = {
	total: number
	free: number
	paid: number
	legacyDeprecatedTotal?: number
}

export type BUnitBalanceRead =
	| { status: 'ok'; balance: BUnitBalance }
	| { status: 'unavailable'; reason: 'api_and_rpc_failed' | 'rpc_timeout' }

/** What a screen keeps: a value, the unavailable marker, or null while the first read is still running. */
export type BUnitBalanceView = BUnitBalance | 'unavailable' | null

export const bunitBalanceView = (read: BUnitBalanceRead): BUnitBalanceView =>
	read.status === 'ok' ? read.balance : 'unavailable'

export interface BUnitBalanceReaders {
	/** The API answer, or null when it is not a valid answer (a failed or non-ok response, or a malformed body). Throws on a network error. */
	readApi: (signal: AbortSignal) => Promise<BUnitBalance | null>
	/** The CoNET RPC read. Returns `unavailable` on a failure; it never returns zeros for a failure. */
	readRpc: () => Promise<BUnitBalanceRead>
}

export async function readBUnitBalanceWithFallback(
	readers: BUnitBalanceReaders,
	timeoutMs: number = BOOT_REQUEST_TIMEOUT_MS,
): Promise<BUnitBalanceRead> {
	const timeout = abortAfter(timeoutMs)
	let fromApi: BUnitBalance | null = null
	try {
		fromApi = await readers.readApi(timeout.signal)
	} catch {
		fromApi = null
	} finally {
		timeout.done()
	}
	if (fromApi) return { status: 'ok', balance: fromApi }
	return withBootTimeout<BUnitBalanceRead>(
		readers.readRpc(),
		timeoutMs,
		{ status: 'unavailable', reason: 'rpc_timeout' },
	)
}

/**
 * The page's transaction sequence for the trusted shell bridge. `pwaWalletSync` and `pwaEmptySignal` draw from this one sequence
 * The shell refuses a
 * request older than its latest accepted number (`stale_seq`), so a restart must never issue a smaller number than before.
 *
 * Each value is above the stored value, above the values issued in this run, and above the current time in milliseconds. The stored
 * counter survives a restart; the clock floor keeps the sequence increasing even if the stored value is lost.
 */

export const SHELL_TX_SEQ_STORAGE_KEY = 'beamio.shellTxSeq.v1'

export type SeqStorage = Pick<Storage, 'getItem' | 'setItem'>

export function createShellTxSeq(storage: SeqStorage | null, now: () => number = Date.now): () => number {
	let issued = 0
	return () => {
		let stored = 0
		try {
			const n = Number(storage?.getItem(SHELL_TX_SEQ_STORAGE_KEY))
			if (Number.isSafeInteger(n) && n > 0) stored = n
		} catch {
			stored = 0
		}
		const next = Math.max(stored, issued, Math.floor(now())) + 1
		issued = next
		try {
			storage?.setItem(SHELL_TX_SEQ_STORAGE_KEY, String(next))
		} catch {
			// not persisted: the clock floor still keeps the next number above this one
		}
		return next
	}
}

function localStorageOrNull(): SeqStorage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage
	} catch {
		return null
	}
}

/** The app-wide sequence. Every trusted call to the shell takes its number here. */
export const nextShellTxSeq = createShellTxSeq(localStorageOrNull())

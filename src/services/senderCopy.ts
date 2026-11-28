/**
 * where the SENDER's copy of a message lives after a reload, and when the send queue may let go of the item.
 *
 * After the local chat library is switched on
 * (`localChatMigrationState` is `switched` or `purged`, or the account's chat bodies were purged: chatLocalPurge.ts), the account record keeps NO message bodies (profilesForPersist strips them) and the
 * conversation is read back from the LIBRARY (chat.tsx: openLocalChatPage). A message reaches the library only through history.append (chatHistoryMirror), which is network bound: the worker
 * syncs the on-chain head and the IPFS index, uploads the fragment, then writes the manifest.
 * So in that mode "the record write succeeded" says nothing about the sender's copy, and the queue item (its own document, on disk from the click) stays until history.append
 * has ACKed.
 *
 * Pure decision here; chat.tsx supplies the pieces.
 */
export type LibraryState = string | null

/** True when the next page load reads the sender's copy from the library, or when that cannot be told (the worker is not ready): then the library ACK is what counts. */
export function libraryHoldsCopy(purgedFlag: boolean, state: LibraryState, capable = true): boolean {
	// the flag (a localStorage value, which may not outlive a killed process) is POSITIVE evidence only. Its absence says nothing; the library's own state
	// (read from its database through the worker) decides, and an unreadable state counts as library mode.
	if (purgedFlag) return true
	if (!capable) return false // a client without a library (a native shell) is record-based: the record write is its durable copy
	return state === null || state === 'switched' || state === 'purged'
}

/** Is the sender's copy durable? Outside library mode: the account record write. In library mode: the library ACK (never the record write). */
export async function senderCopyDurable(input: { recordPersisted: boolean; libraryHolds: boolean; alreadyAcked: boolean; ackLibrary: () => Promise<boolean> }): Promise<boolean> {
	if (!input.libraryHolds) return input.recordPersisted
	if (input.alreadyAcked) return true
	try {
		return await input.ackLibrary()
	} catch {
		return false
	}
}

/**
 * `localChatMigrationState` is a worker call. The SDK bounds it at 60 s, but a page that waits that long keeps the item's `busy` flag for a minute, and every attempt, receipt and
 * resume goes through this read. The page reads it with its own short bound; no answer in time (or a refusal) is "unknown", and unknown counts as library mode (libraryHoldsCopy), the safe side: the item
 * then waits for the library ACK instead of being released on the record write.
 */
export const LIBRARY_STATE_TIMEOUT_MS = 5_000
export function readLibraryStateBounded(read: () => Promise<LibraryState>, timeoutMs: number = LIBRARY_STATE_TIMEOUT_MS): Promise<LibraryState> {
	return new Promise<LibraryState>((resolve) => {
		const timer = setTimeout(() => resolve(null), timeoutMs)
		let p: Promise<LibraryState>
		try {
			p = read()
		} catch {
			clearTimeout(timer)
			resolve(null)
			return
		}
		p.then(
			(v) => { clearTimeout(timer); resolve(v) },
			() => { clearTimeout(timer); resolve(null) },
		)
	})
}

/**
 * the sender's copy is judged by the same three-way mode as the persisted record (chatLocalPurge.ts libraryPersistModeFor), so the two can never disagree about the same client: a native shell has no library
 * (record), a record-based browser account is record, and a known library or an unknown read of a browser library holds the copy until the library ACK.
 */
export const libraryHoldsForMode = (mode: 'library' | 'guarded' | 'record'): boolean => mode !== 'record'

/**
 * a client that is a native shell and has no library (`localChatLibraryCapable` false) is NEVER library mode, whatever a stray flag or an old evidence says: its sender's copy is the account
 * record, and it writes no delivered document (deliveredMarks.ts: the record already holds `delivered`). A browser whose worker is only not up yet (capable false, not a shell) keeps the mode the flag and the
 * evidence give: the flag is positive evidence, and the item is released only after the library ACK, which needs the worker.
 */
export const libraryHoldsForClient = (input: { mode: 'library' | 'guarded' | 'record'; capable: boolean; nativeShell: boolean }): boolean =>
	input.nativeShell && !input.capable ? false : libraryHoldsForMode(input.mode)

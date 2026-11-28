/**
 * the QA control switch "skip the App-level history restore". The App's history restore (applyEntries in App.tsx) merges the worker's decrypted history into the page's in-memory
 * chats; it is the source of the first copy even for a library account (A/B receipt r8hook3). With the switch ON the merge is skipped, so the first copy can only come from the library read and the library path's own speed can be measured.
 * DEFAULT OFF. Stored in localStorage (`beamio.qa.skipAppHistory` = `1`), read at every apply, so a reload keeps it. The only call sites are behind `QA_ACK_ORDER_HOOK`, so a production bundle contains none of it.
 */
export const QA_SKIP_APP_HISTORY_KEY = 'beamio.qa.skipAppHistory'

type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const defaultStorage = (): KV | null => {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage
	} catch {
		return null
	}
}

export function qaSkipAppHistoryOn(storage: KV | null = defaultStorage()): boolean {
	try {
		return storage?.getItem(QA_SKIP_APP_HISTORY_KEY) === '1'
	} catch {
		return false
	}
}

export function setQaSkipAppHistory(on: boolean, storage: KV | null = defaultStorage()): void {
	try {
		if (on) storage?.setItem(QA_SKIP_APP_HISTORY_KEY, '1')
		else storage?.removeItem(QA_SKIP_APP_HISTORY_KEY)
	} catch {
		/* a storage that cannot be written leaves the switch off */
	}
}

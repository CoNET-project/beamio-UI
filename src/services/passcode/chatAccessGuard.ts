/**
 * UI chat access guard (unit e, the recorded rule).
 *
 * The PWA is the single authority for chat access while the UI is locked. The native SDK keeps no lock of its own.
 * - `lockChatAccess()` runs on every UI lock. It drops the in-memory passcode session key (walletVault session.pc).
 * - `unlockChatAccess(account)` runs only after a successful UI unlock for that account.
 * - `clearChatAccessState(passcodeOn)` runs on sign-out / account switch: the unlock is dropped, and the lock is kept only when a passcode is on.
 * - Reload: the state is module memory only, so a fresh module starts without any unlock record.
 *
 * Entry points (chatWorkerBridge.ts, chat.ts) call `chatAccessRefused(kind)` first and send no bridge request when it returns true.
 * Nothing here reads or writes the stored wallet; the storage format is unchanged.
 */
import { lockWalletSession } from './walletVault'

/** The chat operations the guard covers. */
export type ChatAccessKind = 'send' | 'history_read' | 'history_load' | 'local_read'

export type ChatAccessState = {
	/** true while the UI lock is shown. Chat is refused. */
	readonly locked: boolean
	/** the account the last successful UI unlock was for (lower case), or null. */
	readonly unlockedAccount: string | null
}

let state: ChatAccessState = { locked: false, unlockedAccount: null }
const listeners = new Set<() => void>()

const publish = (next: ChatAccessState): void => {
	state = next
	for (const cb of [...listeners]) cb()
}

/** Current guard state. The object is replaced on every change (safe for useSyncExternalStore). */
export const getChatAccessState = (): ChatAccessState => state

/** Subscribes to state changes. Returns the unsubscribe function. */
export const subscribeChatAccess = (cb: () => void): (() => void) => {
	listeners.add(cb)
	return () => {
		listeners.delete(cb)
	}
}

/** A UI lock is shown. Drops the passcode session key and any unlock record. */
export function lockChatAccess(): void {
	lockWalletSession()
	publish({ locked: true, unlockedAccount: null })
}

/** The UI unlock succeeded for `account`. Chat access resumes. */
export function unlockChatAccess(account: string): void {
	publish({ locked: false, unlockedAccount: account.toLowerCase() })
}

/**
 * Sign-out or account switch: the previous account's unlock record and passcode session key are dropped.
 * `passcodeOn` says whether the UI lock must be shown again (a passcode is set). Without a passcode nothing is locked.
 */
export function clearChatAccessState(passcodeOn: boolean): void {
	lockWalletSession()
	publish({ locked: passcodeOn, unlockedAccount: null })
}

/** True when the chat operation must be refused. The caller sends no bridge request in that case. */
export function chatAccessRefused(kind: ChatAccessKind): boolean {
	if (!state.locked) return false
	console.warn(`[chatAccess] ${kind} refused: UI locked`)
	return true
}

/**
 * The chat UI state in a shell (option A): `chat_unavailable` shows the unified notice in place of the chat;
 * `native_chat` and `browser_chat` show the chat. The state is set from the shell's `hello` answer at start (AppEntryGate).
 * Read with `useShellChatUiState`.
 */
import type { UiState } from './shellChatState'
import { isShellChatLive } from './shellChatLive'
import { publishNativePwaLog } from '@/utils/cashTreesNativePwaLog'

let current: UiState = 'browser_chat'
const listeners = new Set<(state: UiState) => void>()

export function getShellChatUiState(): UiState {
	return current
}

/**
 * `reason` names the writer in the log (a fixed word, no content): a state change reaches the native log as `[ShellChatUi] from -> to (reason)`. While the native chat is live a
 * notice state does not replace `native_chat` (shellChatLive.ts): the refused write is logged too.
 */
export function setShellChatUiState(next: UiState, reason: string = 'unspecified'): void {
	if (next === current) return
	if (next !== 'native_chat' && current === 'native_chat' && isShellChatLive()) {
		publishNativePwaLog('info', `[ShellChatUi] ${current} -> ${next} refused while the native chat is live (${reason})`)
		return
	}
	publishNativePwaLog('info', `[ShellChatUi] ${current} -> ${next} (${reason})`)
	current = next
	for (const listener of [...listeners]) listener(next)
}

export function subscribeShellChatUiState(listener: (state: UiState) => void): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

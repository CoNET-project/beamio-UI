/**
 * The chat UI state in a shell (option A): `chat_unavailable` shows the unified notice in place of the chat;
 * `native_chat` and `browser_chat` show the chat. The state is set from the shell's `hello` answer at start (AppEntryGate).
 * Read with `useShellChatUiState`.
 */
import type { UiState } from './shellChatState'

let current: UiState = 'browser_chat'
const listeners = new Set<(state: UiState) => void>()

export function getShellChatUiState(): UiState {
	return current
}

export function setShellChatUiState(next: UiState): void {
	if (next === current) return
	current = next
	for (const listener of [...listeners]) listener(next)
}

export function subscribeShellChatUiState(listener: (state: UiState) => void): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

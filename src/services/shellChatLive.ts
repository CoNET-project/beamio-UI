/**
 * whether the shell's native chat start has succeeded and the chat is live in this page.
 *
 * A live native chat proves what every notice state claims is missing: the shell declared identity.native-keys.v1 and the identity is ready (the listen start refuses otherwise).
 * The chat UI state (`native_chat`, `identity_pending`, `chat_unavailable`) is a separate flag written by several paths; one of them could leave it at a notice state after the
 * chat was already listening, and nothing set it back (the prompt "The native wallet is not ready yet" on every tap, until a cold start). While the chat is live the UI state
 * is kept at `native_chat` (shellChatUiState.ts) and healed when a blocked check finds it otherwise (shellChatCapability.ts).
 * Set by chat.ts: true when a start ends `started`, false when the session is cleared, the start ends otherwise, or the account signs out.
 */
let live = false

export function setShellChatLive(next: boolean): void {
	live = next
}

export function isShellChatLive(): boolean {
	return live
}

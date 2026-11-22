/**
 * The trust gate of a held send. Two rules:
 *
 * 1. The send gate reads the verified fingerprint from the STORED chat row only. A value that exists only in the page's memory copy is not
 * trust (it was observed in the field: the memory copy held a verified fingerprint that the stored copy did not). `gateChatFromStore`
 * gives the gate a copy whose verified fingerprint is the stored one, or none.
 * 2. "Verify and send" without the key on screen (after a reload, no pinned key in memory) never sends. It reads the key once and opens the
 * verify panel; only "Verified, continue" writes trust and resends (the resend reads the stored trust).
 *
 * Pure: no page state, no storage. The page supplies the stored value.
 */

/**
 * The gate copy with the stored trust, and the QA trace fields (booleans and the writer label only). The page reads the stored value and passes it.
 */
export function gateCopyWithStore<T extends { chatData?: object | null }>(chat: T, storedVerified: string | null | undefined, memWriter: string): { gate: T; trace: { memory: boolean; stored: boolean; memWriter: string } } {
	const memory = !!(chat.chatData as { verifiedFingerprint?: string } | null | undefined)?.verifiedFingerprint
	return { gate: gateChatFromStore(chat, storedVerified), trace: { memory, stored: !!storedVerified, memWriter } }
}

export type HeldTrustCode = 'ok' | 'first_fetch_pending' | 'other'
export type VerifyModeDecision = 'open_panel' | 'send'

/** The chat copy for the send gate: its verified fingerprint is the stored one (or none). Never a memory-only value. */
export function gateChatFromStore<T extends { chatData?: object | null }>(chat: T, storedVerified: string | null | undefined): T {
	const base = (chat.chatData ?? {}) as Record<string, unknown>
	const chatData = { ...base }
	if (storedVerified) chatData.verifiedFingerprint = storedVerified
	else delete chatData.verifiedFingerprint
	return { ...chat, chatData } as T
}

/**
 * A verify or accept press without the key on screen: the panel opens when the contact is a first contact awaiting verification. Anything
 * else goes to the send gate, which holds it (it never sends an unverified key).
 */
export function verifyModeDecision(input: { mode: 'fresh' | 'cached' | 'accept' | 'verify'; hasPinned: boolean; trust: HeldTrustCode }): VerifyModeDecision {
	const wantsPinned = input.mode === 'verify' || input.mode === 'accept'
	if (wantsPinned && !input.hasPinned && input.trust === 'first_fetch_pending') return 'open_panel'
	return 'send'
}

/**
 * Where the verified fingerprint on the memory copy came from, for the QA trace (no content): the last trust write of this session, a
 * refresh that carried an older value, or none.
 */
export type MemoryTrustWriter = 'trust' | 'carried' | 'none'
export function nextMemoryTrustWriter(prev: MemoryTrustWriter, input: { trusted: boolean; hadVerified: boolean; hasVerified: boolean }): MemoryTrustWriter {
	if (input.trusted && input.hasVerified) return 'trust'
	if (input.hasVerified && input.hadVerified) return prev === 'trust' ? 'trust' : 'carried'
	if (!input.hasVerified) return 'none'
	return prev
}

/**
 * The bubble of a held text: a held message whose key is already verified in the stored trust is not "Not verified yet" any more.
 * Its key is the verified one: the bubble offers the send again (retry). A stored trust for another key is a changed key.
 */
export type HeldBubble = 'first_fetch_pending' | 'trusted_resend' | 'fingerprint_changed'
export function heldBubble(input: { sendFingerprint?: string | null; storedVerified?: string | null; storedKeyFingerprint: (fp: string) => string }): HeldBubble {
	if (!input.storedVerified || !input.sendFingerprint) return 'first_fetch_pending'
	return input.storedKeyFingerprint(input.sendFingerprint) === input.storedVerified ? 'trusted_resend' : 'fingerprint_changed'
}

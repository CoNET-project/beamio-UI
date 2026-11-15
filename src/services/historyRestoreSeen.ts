/**
 * key changed by: the history restore can be fed the same entries again (the buffer, the decrypted
 * history, the read at start; each load after a gossip start replays the history). The merge is idempotent, but every batch was still
 * processed and logged. An entry merged once in this session is skipped.
 *
 * The key is the owner, the peer, the direction, the SHA-256 of the body, and the time:
 *   owner | peer | dir | sha256(body) | ts
 * - owner is the history manifest EOA (the address of the private key that signs the history), in lower case. It is NOT the keyID:
 *   the claimant must come from the private key (see the note in App.tsx at the claim effect).
 * - seq is NOT in the key. It is the position in the manifest and changes when the manifest is rebuilt (relinearize), so it is no identity.
 * - sendId is NOT in the key. The SDK derives a send id (D10) for entries that have none, and it can appear after a rebuild; the same
 *   message would then get a second key and be merged twice. The body hash does not change with it.
 * Two different messages with the same owner, peer, direction, body and time are one key. That is accepted: the merge is idempotent,
 * so the cost is only a skipped repeat of one identical body at one time.
 *
 * Transitional: the SDK page type carries no sendKey today (HistoryEntry = {seq, ts, peer, dir, sendId?, body}). When the SDK
 * gives every entry a stable sendKey, the body hash can be replaced by it; until then the body hash is the identity. SYNTHETIC values only.
 */
import { sha256OfText } from '../utils/sha256'
import type { HistoryEntry } from '@conet.project/chat-sdk'

/**
 * The entry's identity in this session: owner (EOA), peer, direction, the body hash and the time (see the header).
 * `owner` is any string; it is lower-cased here.
 */
export const historyEntryKey = (owner: string, e: Pick<HistoryEntry, 'peer' | 'dir' | 'ts' | 'body'>): string =>
	`${(owner || '').toLowerCase()}|${(e.peer || '').toLowerCase()}|${e.dir}|${sha256OfText(e.body || '')}|${e.ts}`

/**
 * The entries whose key is not in `seen`yet, in their order. With no owner (the account is unknown) nothing is skipped: every
 * entry is returned, and markHistoryEntriesSeen records nothing for it.
 */
export const unseenHistoryEntries = (
	owner: string,
	seen: ReadonlySet<string>,
	entries: readonly HistoryEntry[],
): HistoryEntry[] => {
	if (!owner) return entries.filter((e) => !!e)
	return entries.filter((e) => !!e && !seen.has(historyEntryKey(owner, e)))
}

/** Records the entries as merged. With no owner nothing is recorded. */
export const markHistoryEntriesSeen = (owner: string, seen: Set<string>, entries: readonly HistoryEntry[]): void => {
	if (!owner) return
	for (const e of entries) if (e) seen.add(historyEntryKey(owner, e))
}

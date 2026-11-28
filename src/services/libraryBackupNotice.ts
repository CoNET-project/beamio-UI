/**
 * the notice for a message whose proof was seen (the receipt) but whose copy is still not durable where the next load reads it (library mode: `history.append` not ACKed, senderCopy.ts).
 * Such an item is NEVER released without the ACK (a release would lose the sender's copy on the next reload: G1), so it can wait a long time when the worker keeps refusing. The user sees the message
 * as sent / delivered; this notice tells them, after a long wait, that it exists only on this device so far.
 *
 * Wording: after 10 minutes the bubble says "本地备份仍在重试" and the automatic retry goes on (the queue item keeps retrying; nothing here stops it).
 * The English line "Local backup is still retrying" (locale/en.json) is draft wording. There is no other locale file. The earlier placeholder copy is gone.
 */
export const LIBRARY_BACKUP_NOTICE_AFTER_MS = 10 * 60 * 1000 // 10 minutes
export const LIBRARY_BACKUP_NOTICE_COPY_KEY = 'chat.status.backup_retrying' // the wording is in locale/en.json and locale/zh-CN.json
/** how often the page re-evaluates which bubbles show the notice */
export const LIBRARY_BACKUP_NOTICE_CHECK_MS = 30_000

/** The sendIds that show the notice: confirmed items that have been confirmed (and not durable) for at least the wait. */
export function backupPendingSendIds(snapshot: ReadonlyArray<{ sendId: string; state: string; confirmedSince: number | null }>, now: number, afterMs: number = LIBRARY_BACKUP_NOTICE_AFTER_MS): string[] {
	const out: string[] = []
	for (const s of snapshot) {
		if (s.state === 'confirmed' && s.confirmedSince !== null && now - s.confirmedSince >= afterMs) out.push(s.sendId)
	}
	return out
}

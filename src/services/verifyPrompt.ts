/**
 * The one-time verification prompt for an existing contact. It is due when the contact has no verified key and the user has not
 * dismissed it for this contact. Dismissal and verification are persisted per contact (`verifyPromptSeen` on the stored chat record).
 */
import { readStoredKeyFingerprint } from '@/utils/pgpFingerprint'

export function oneTimeVerifyPromptDue(
	chat: { verifyPromptSeen?: boolean; chatData?: { verifiedFingerprint?: string } | null } | null | undefined,
): boolean {
	if (!chat) return false
	if (chat.verifyPromptSeen) return false
	return !readStoredKeyFingerprint(chat.chatData?.verifiedFingerprint)
}

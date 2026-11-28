/**
 * how the client reads the answer of an entry POST and reuses the armor of a sendId. Pure helpers (chat.ts sendMessage uses them), so they are testable on their own.
 */
import { readKey, readMessage } from 'openpgp'
import { ethers } from 'ethers'

/**
 * The armor text a receipt digest is computed over, on the MAILBOX WORK path (the path the SDK posts on): the `data` string, trimmed, then cut right after the END marker. null when it is not a PGP message armor.
 * No CRLF -> LF conversion: an armor with CR keeps it.
 * The digest `h` of a receipt is computed over THIS text, never over the raw string with its trailing newline.
 */
export const asPgpMessageArmor = (text: string): string | null => {
	const trimmed = String(text ?? '').trim()
	if (!trimmed.startsWith('-----BEGIN PGP MESSAGE-----')) return null
	const end = trimmed.indexOf('-----END PGP MESSAGE-----')
	if (end < 0) return null
	return trimmed.slice(0, end + '-----END PGP MESSAGE-----'.length)
}

/** keccak256 of the UTF-8 bytes of a text. */
export const hashPgpArmorText = (text: string): string => ethers.keccak256(ethers.toUtf8Bytes(text))

/** The digest a bound receipt echoes for an armor the client sends: over the trimmed, END-cut armor (CR kept, mailbox work path). */
export const armorDigest = (armor: string): string => hashPgpArmorText(asPgpMessageArmor(armor) ?? armor)

/**
 * What an entry POST answered, for the send queue (which decides when an item may leave the queue).
 *  - 'bound': the mailbox answered {"ok":true,"stored":true|"duplicate":true,"h":"0x..."} and h is the keccak256 of the inner armor THIS request carried, trimmed and cut after the END marker (armorDigest). `stored` and
 *    `duplicate` are both positive: duplicate only says it is still kept now (after the recipient's ACK deleted it, a retry answers stored).
 *  - 'legacy_empty': HTTP 2xx with an EMPTY body. It does not say whether the message was stored.
 * Anything else (read failure, ok:false, a body that is not ours, another digest) is a failure of this attempt and never counts as a receipt.
 */
export type SendReceipt = { kind: 'bound' | 'legacy_empty'; digest: string }

/** the inner armor of one message (one sendId), persisted by the caller before the first request goes out and reused by every retry: a retry never encrypts the message a second time. */
export type SendArmorContext = {
	/** the armor stored by the first attempt, if any */
	armor?: string
	/** persist the freshly made armor and its digest; a rejection means nothing is sent (the armor has no stored copy) */
	record: (armor: string, digest: string) => Promise<void>
}

/** True when `armor` is encrypted to the recipient's CURRENT encryption key (a retry may reuse it); false: the key changed, a new armor must be made. */
export const armorMatchesRecipient = async (armor: string, recipientPublicArmored: string): Promise<boolean> => {
	try {
		const message = await readMessage({ armoredMessage: armor })
		const key = await readKey({ armoredKey: recipientPublicArmored })
		const wanted = new Set<string>([key.getKeyID().toHex(), ...key.subkeys.map((k) => k.getKeyID().toHex())])
		return message.getEncryptionKeyIDs().some((id) => wanted.has(id.toHex()))
	} catch {
		return false
	}
}

/** The verdict on one answer of the entry (pure, tested): 'bound' | 'legacy_empty' | 'reject'. */
export const classifySendAnswer = (answer: string | null, digest: string): 'bound' | 'legacy_empty' | 'reject' => {
	if (answer === null) return 'reject' // the body could not be read: unknown, never a receipt
	const body = answer.trim()
	if (body === '') return 'legacy_empty'
	let parsed: { ok?: unknown; h?: unknown; stored?: unknown; duplicate?: unknown } | null = null
	try {
		parsed = JSON.parse(body)
	} catch {
		return 'reject' // not JSON and not empty: not an answer of the mailbox protocol
	}
	if (!parsed || typeof parsed !== 'object' || parsed.ok !== true) return 'reject' // ok:false, no ok, or not an object
	// it must say what happened to the message: kept now (`stored`) or still kept (`duplicate`), as the boolean true (the same rule as the shells' answer, nativeSendProtocol.ts)
	if (parsed.stored !== true && parsed.duplicate !== true) return 'reject'
	return typeof parsed.h === 'string' && parsed.h.toLowerCase() === digest.toLowerCase() ? 'bound' : 'reject' // a receipt for another message is not ours
}


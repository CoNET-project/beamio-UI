/**
 * The wire of a held text message, rebuilt from the stored message (BCHAT 38). A text send builds `{sendId, from:'me', text, createdAt,
 * quote?}`; the stored message carries the same fields, so after a reload the held text is the same wire. Other kinds of message (files,
 * voice, calls, payments, replies) are not rebuilt here and return null.
 */
export interface StoredTextMessage {
	sendId?: string
	from: 'me' | 'them'
	text?: unknown
	createdAt?: unknown
	quote?: unknown
	fileMessage?: unknown
	fileMessageCipher?: unknown
	voiceMessage?: unknown
	callRecord?: unknown
	paymentCard?: unknown
	reply?: unknown
}

export function heldWireFromMessage(m: StoredTextMessage): string | null {
	if (m.from !== 'me' || typeof m.text !== 'string' || typeof m.sendId !== 'string' || !m.sendId) return null
	if (typeof m.createdAt !== 'number') return null
	if (m.fileMessage || m.fileMessageCipher || m.voiceMessage || m.callRecord || m.paymentCard || m.reply) return null
	const payload = {
		sendId: m.sendId,
		from: 'me' as const,
		text: m.text,
		createdAt: m.createdAt,
		...(m.quote ? { quote: m.quote } : {}),
	}
	return JSON.stringify(payload)
}

/**
 * The receiver's merge of one inbound payload into the stored message list (moved out of chat.ts so that it can be tested without the chat service; chat.ts re-exports makeMessage).
 * a message that carries a sendId is keyed by it (stableChatMessageId): the same sendId arriving again (a retry with the same armor, a node that stored nothing but still delivered
 * live, a resume after a lost receipt) is one message, never two.
 */
const stableChatMessageId = (m: ChatMessage | null | undefined, fallbackTs?: number): string => {
	if (m?.id?.startsWith('tmp_')) return String(m.id)
	const sendId = typeof m?.sendId === 'string' ? m.sendId.trim() : ''
	if (sendId) return sendId
	if (typeof m?.id === 'string' && m.id.trim()) return m.id.trim()
	const created = Number(m?.createdAt)
	if (Number.isFinite(created)) return String(created)
	if (Number.isFinite(Number(fallbackTs))) return String(fallbackTs)
	return `msg_${Math.random().toString(16).slice(2)}`
}

export const makeMessage = (
	data: ChatMessage[],
	newChatText: string,
	timestamp: number,
	from: "me" | "them",
	status?: "sending" | "sent" | "delivered" | "failed" | "route_unconfirmed" | "fingerprint_changed" | "first_fetch_pending",
	/** Inbound only: the claimed wallet when it differs from the recovered signer. */
	/** Inbound only: the text passed the voice ingestion gate (a stored voice signal may drive call state; no key is stored). */
	meta?: { claimedFrom?: string; voiceVerified?: boolean },
) => {
	// 1) Normalize existing rows — never rewrite sendId-backed ids to createdAt alone
	// (that dropped merchantGift when a note shared the same millisecond).
	const normalized = (data || []).map((m) => {
		if (m?.id?.startsWith('tmp_')) return m
		const id = stableChatMessageId(m)
		return { ...m, id }
	})

	const seen = new Set<string>()
	const result: ChatMessage[] = []

	for (const m of normalized) {
		if (!m) continue
		const key = stableChatMessageId(m)
		if (!key || seen.has(key)) continue
		seen.add(key)
		result.push({ ...m, id: key })
	}

	// 2) Merge the inbound payload (JSON card / sendId text / plain text)
	const resultLenBefore = result.length
	const ts = Number(timestamp)
	const text = (newChatText || '').trim()
	try {
		const card: ChatMessage = JSON.parse(text)
		const dedupKey = stableChatMessageId(card, ts)
		if (seen.has(dedupKey)) {
			// duplicate push — keep existing
		} else if (card.paymentCard) {
			card.from = 'them'
			card.id = dedupKey
			if (card.createdAt == null) card.createdAt = ts
			seen.add(dedupKey)
			result.push(card)
		} else if (card.reply) {
			card.from = 'them'
			card.id = dedupKey
			if (card.createdAt == null) card.createdAt = ts
			seen.add(dedupKey)
			result.push(card)
		} else if (card.sendId != null) {
			card.from = 'them'
			card.id = dedupKey
			if (card.createdAt == null) card.createdAt = ts
			seen.add(dedupKey)
			result.push(card)
		} else throw new Error('')
	} catch {
		if (text && Number.isFinite(ts)) {
			const incomingId = String(ts)
			if (!seen.has(incomingId)) {
				seen.add(incomingId)
				result.push({
					id: incomingId,
					from,
					text,
					createdAt: ts,
					status: status ?? (from === 'me' ? 'sent' : 'sent'),
				})
			}
		}
	}

	// Flag only the row this call added (never an older message).
	if (meta?.claimedFrom && result.length > resultLenBefore) {
		const added = result[result.length - 1]
		if (added && added.from === 'them') added.claimedFrom = meta.claimedFrom
	}
	if (meta?.voiceVerified && result.length > resultLenBefore) {
		const added = result[result.length - 1]
		if (added && added.from === 'them') (added as ChatMessage & { voiceVerified?: boolean }).voiceVerified = true
	}
	result.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
	return result
}

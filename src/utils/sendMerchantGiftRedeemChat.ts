import { lookupRecipientRecord } from '@/services/chat'
import { resolveRecipientForSend } from '@/utils/recipientPublicKey'
import { ethers } from 'ethers'
import {
	createMerchantGiftRedeemCard,
	initMessage,
	sendMessage,
} from '@/services/chat'
import { mirrorChatMessageToHistoryAck } from '@/services/chatHistoryMirror'
import { chatDraftDocAdapter, commitForChat } from '@/services/beamio'
import { durableCommitError } from '@/services/durableCommit'
import { createChatDocStores } from '@/services/chatDocStores'
import { webLocksClaim } from '@/services/sendQueue'
import { sendQueuedCards, type CardSendEntry } from '@/services/queuedCardSend'
import { isShellContext } from '@/services/shellContext'
import { CoNET_Data, setCoNET_Data } from '@/utils/globals'

export type SendMerchantGiftRedeemChatParams = {
	profiles: profile[]
	setProfiles: React.Dispatch<React.SetStateAction<profile[]>>
	allNodes: nodeInfo[]
	friend: searchResult
	privateKeyArmor: string
	amount: number
	currency: ICurrency
	merchantTitle: string
	claimUrl: string
	/** Tier background selected by the purchaser */
	imageUrl?: string | null
	/** Optional personalized note sent as a normal text bubble before the gift card */
	note?: string
}

/**
 * After a successful gift purchase with Direct @BeamioTag delivery:
 * ensure chat session, optionally send note, then send merchantGift paymentCard.
 * Encrypts to the friend's EOA user PGP (exact BeamioTag profile).
 */
export async function sendMerchantGiftRedeemChat(
	params: SendMerchantGiftRedeemChatParams,
): Promise<{ ok: boolean; error?: string }> {
	const {
		profiles,
		setProfiles,
		allNodes,
		friend,
		privateKeyArmor,
		amount,
		currency,
		merchantTitle,
		claimUrl,
		imageUrl,
		note,
	} = params

	const friendAddress = (friend.address ?? '').trim()
	if (!friendAddress || !ethers.isAddress(friendAddress)) {
		return { ok: false, error: 'Friend address is missing.' }
	}
	if (!privateKeyArmor?.trim()) {
		return { ok: false, error: 'Wallet signing key is unavailable.' }
	}
	if (!claimUrl.trim()) {
		return { ok: false, error: 'Claim link is missing.' }
	}
	if (!allNodes?.length) {
		return { ok: false, error: 'CoNET nodes are not ready. Gift was purchased; notify your friend with the claim link.' }
	}
	if (!profiles?.length) {
		return { ok: false, error: 'Profile is not loaded.' }
	}

	const profile = profiles[0]
	const pk = privateKeyArmor.trim()
	profile.privateKeyArmor = pk

	const chat = await initMessage(profile, friend)
	const recipientKey = await resolveRecipientForSend(chat, lookupRecipientRecord)
	if (!chat || !recipientKey.ok) {
		return {
			ok: false,
			error: `Could not open chat with this friend (${recipientKey.ok ? 'no_chat' : recipientKey.code}). Share the claim link instead.`,
		}
	}

	const now = Date.now()
	const outbound: ChatMessage[] = []

	const noteText = (note ?? '').trim()
	if (noteText) {
		const sendId =
			typeof crypto !== 'undefined' && crypto.randomUUID
				? crypto.randomUUID()
				: `note_${now}_${Math.random().toString(36).slice(2)}`
		const noteMsg: ChatMessage = {
			id: sendId,
			sendId,
			from: 'me',
			text: noteText,
			createdAt: now,
			status: 'sending',
		}
		outbound.push(noteMsg)
	}

	const giftCard = createMerchantGiftRedeemCard({
		amount,
		currency,
		merchantTitle,
		claimUrl: claimUrl.trim(),
		imageUrl: imageUrl?.trim() || undefined,
		memo: noteText || undefined,
		usdcAmount: amount,
	})
	// Distinct from optional note so timestamp-only fallbacks never collide.
	giftCard.createdAt = now + 1
	if (giftCard.paymentCard) {
		giftCard.paymentCard.timeStamp = now + 1
	}
	outbound.push(giftCard)

	const peer = (friendAddress || chat.address || '').toLowerCase()
	const wallet = String(profile.keyID || '')
	const failedText = 'Gift purchased, but chat delivery failed. Share the claim link with your friend.'
	const stores = createChatDocStores({ eoa: wallet.toLowerCase(), privateKey: pk, nativeShell: isShellContext(), doc: chatDraftDocAdapter })
	if (!stores || !wallet) return { ok: false, error: failedText }

	// the payload of a card is the message as it was built; the copy this device shows starts as `sending` and turns `sent` only when the send was answered
	const entries: CardSendEntry<ChatMessage>[] = outbound.map((msg) => ({
		sendId: String(msg.sendId),
		createdAt: Number(msg.createdAt),
		text: msg.paymentCard != null ? '' : msg.text,
		payload: msg.paymentCard != null
			? JSON.stringify(msg)
			: JSON.stringify({ sendId: msg.sendId, from: 'me' as const, text: msg.text, createdAt: msg.createdAt }),
		message: { ...msg, status: 'sending' },
	}))

	const publish = () => {
		setProfiles([...profiles])
		const temp = CoNET_Data
		if (temp) {
			temp.profiles = profiles
			setCoNET_Data(temp)
		}
	}
	/** the row of this conversation as the account holds it NOW (the page may have replaced the object meanwhile) */
	const currentRow = (): chatData => (CoNET_Data?.profiles?.[0]?.chats as chatData[] | undefined)?.find((c) => String(c.address || '').toLowerCase() === String(chat.address || '').toLowerCase()) ?? chat

	const result = await sendQueuedCards<ChatMessage>(entries, {
		wallet,
		peer,
		store: stores.queueStore,
		claim: webLocksClaim(wallet.toLowerCase()),
		show: (messages) => {
			const row = currentRow()
			row.messages = [...(row.messages || []), ...messages]
			publish()
		},
		setStatus: (sendId, status, sendError) => {
			const row = currentRow()
			row.messages = (row.messages || []).map((m) => (m.from === 'me' && m.sendId === sendId && m.status !== 'delivered' ? { ...m, status, sendError } : m))
			publish()
		},
		persist: async () => {
			const failure = durableCommitError(await commitForChat())
			if (failure) throw failure
		},
		transmit: (payload, armor, onReceipt) => sendMessage(recipientKey.publicArmored, payload, pk, allNodes, { armor, onReceipt }),
		archive: (message) => mirrorChatMessageToHistoryAck(peer, message, 'out'),
	})

	if (result.notAccepted.length || result.failed.length) return { ok: false, error: failedText }

	return { ok: true }
}

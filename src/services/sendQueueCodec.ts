/**
 * The codec of the queue and receipt documents (one place, so the page that writes a receipt document and the conversation that reads it can never disagree): AES-GCM under keccak256(the account's key armor)
 * in the browser; the shells have no page key and get base64 JSON, which is NOT encryption (the same protection as the messages already stored there).
 *
 * the ids of the receipt and delivered documents must not show a contact or a sendId. They carry keyed tags instead (docTaggerFor): HMAC-SHA256 over a labelled value, under a key that is
 * derived IN MEMORY from the same account key armor as the codec (keccak256 over a domain label and the armor, so it is not the AES key), cut to 16 bytes. The real peer and sendId are in the sealed body and are
 * checked on every read. A tag is deterministic, so all documents of one contact can still be listed by prefix. The key armor is never stored, logged or returned.
 * In a shell there is no key armor in the page: the tag key then comes from the public account address only. That tag is NOT secret (anyone who guesses a contact address can compute it); it only keeps the id from
 * showing the address and the sendId at a glance. `keyed` tells which of the two it is; nothing may call the shell variant confidential.
 */
import { ethers } from 'ethers'
import { aesGcmCodec, base64JsonCodec, type DraftCodec } from './chatDraftStore'

export function queueCodecFor(privateKeyArmor: string | undefined | null): DraftCodec {
	let codec = base64JsonCodec()
	if (privateKeyArmor) {
		try { codec = aesGcmCodec(ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(privateKeyArmor)))) } catch { /* keep the base64 JSON codec */ }
	}
	return codec
}

export interface DocTagger {
	/** true when the tag key comes from the account key armor (browser); false in a shell (public address only: not secret) */
	readonly keyed: boolean
	/** deterministic tag of a contact address (case-insensitive) */
	peerTag(peer: string): string
	/** deterministic tag of a sendId */
	sendTag(sendId: string): string
}

const TAG_LABEL = 'beamio-chat-doc-tag-v1:'
const lowerOf = (s: string): string => String(s || '').trim().toLowerCase()

export function docTaggerFor(privateKeyArmor: string | undefined | null, eoa: string): DocTagger {
	let keyed = false
	let key: Uint8Array
	if (privateKeyArmor) {
		try {
			key = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(`${TAG_LABEL}${privateKeyArmor}`)))
			keyed = true
		} catch {
			key = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(`${TAG_LABEL}no-key:${lowerOf(eoa)}`)))
		}
	} else {
		key = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(`${TAG_LABEL}no-key:${lowerOf(eoa)}`)))
	}
	const tag = (label: string, value: string): string => ethers.hexlify(ethers.getBytes(ethers.computeHmac('sha256', key, ethers.toUtf8Bytes(`${label}:${value}`))).slice(0, 16)).slice(2)
	return {
		keyed,
		peerTag: (peer) => tag('peer', lowerOf(peer)),
		sendTag: (sendId) => tag('send', String(sendId || '').trim()),
	}
}

/**
 * The cleaners (receiptEvidence.ts pruneOrphans, deliveredMarks.ts prune) judge a document by its id and by what they can decode. In a browser page whose account key armor is not known YET (the chat page mounts
 * once before its key state is set, then again with it) the codec and the tags are the keyless ones: every sealed document looks unreadable and every keyed id looks foreign, which is exactly what a cleaner
 * would delete. So a cleaner runs only with the right key: keyed tags (a browser with its armor), or a native shell (no armor exists there, the keyless variant IS the right one).
 * Round 2: the same rule decides whether the four stores (queue, draft, receipt, delivered) are CREATED and written at all (chat.tsx), and whether the receipt step of an inbound batch may read or write (App.tsx):
 * a browser without its key would otherwise write base64 plaintext (a draft, a queue item, a receipt) that the keyed page can never read again.
 */
export const mayUseChatDocs = (tags: DocTagger, nativeShell: boolean): boolean => tags.keyed || nativeShell
/** the same rule under its first name (the cleaners) */
export const mayCleanChatDocs = mayUseChatDocs

import { ethers } from 'ethers'
import { runChatMediaTask } from './mediaFragment'
import { fetchAndDecryptFragment } from '../services/chatMediaWorkerBridge'

export const VOICE_MESSAGE_TYPE = 'voice_message_v1' as const
export const VOICE_CHUNK_BYTES = 512 * 1024
export const VOICE_MAX_DATA_URL_CHARS = 240 * 1024 * 1024
/** Approximate raw audio ceiling after Data URL/base64 overhead and AES-GCM tag. */
export const VOICE_MAX_AUDIO_BYTES = Math.floor((VOICE_MAX_DATA_URL_CHARS - 64) * 0.75) - 16
const IPFS_API = 'https://ipfs.conet.network/api'
const VOICE_DIRECT_UPLOAD_MAX_DATA_URL_CHARS = 48 * 1024 * 1024

export type VoiceMessageManifest = {
	type: typeof VOICE_MESSAGE_TYPE
	fragmentHash: string
	key: string
	iv: string
	mime: string
	durationMs: number
	sizeBytes: number
}

const bytesToBase64 = (bytes: Uint8Array): string => {
	let binary = ''
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
	}
	return btoa(binary)
}

export async function encryptVoiceBlob(blob: Blob, durationMs: number): Promise<{
	dataUrl: string
	manifest: Omit<VoiceMessageManifest, 'fragmentHash'>
}> {
	const plaintext = new Uint8Array(await blob.arrayBuffer())
	const keyBytes = crypto.getRandomValues(new Uint8Array(32))
	const iv = crypto.getRandomValues(new Uint8Array(12))
	const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt'])
	const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext))
	const dataUrl = `data:application/octet-stream;base64,${bytesToBase64(encrypted)}`
	if (dataUrl.length > VOICE_MAX_DATA_URL_CHARS) {
		throw new Error('This voice message is too large to upload safely. Please record a shorter message.')
	}
	return {
		dataUrl,
		manifest: {
			type: VOICE_MESSAGE_TYPE,
			key: bytesToBase64(keyBytes),
			iv: bytesToBase64(iv),
			mime: blob.type || 'audio/webm',
			durationMs: Math.max(0, Math.round(durationMs)),
			sizeBytes: plaintext.byteLength,
		},
	}
}

/** Upload encrypted data in 512 KiB chunks; the server assembles the original Data URL. */
export async function uploadEncryptedVoiceDataUrl(
	privateKey: string,
	dataUrl: string,
	onProgress?: (fraction: number) => void,
): Promise<string> {
	const wallet = new ethers.Wallet(privateKey)
	const fragmentHash = ethers.keccak256(ethers.toUtf8Bytes(dataUrl))
	const signMessage = await wallet.signMessage(wallet.address)
	const payloadBytes = new TextEncoder().encode(dataUrl)
	const totalSize = payloadBytes.length
	const statusParams = new URLSearchParams({
		hash: fragmentHash,
		wallet: wallet.address,
		signMessage,
	})
	const statusResponse = await fetch(
		`${IPFS_API}/storageFragmentChunkStatus?${statusParams.toString()}`,
	)
	const status = (await statusResponse.json().catch(() => null)) as {
		ok?: boolean
		complete?: boolean
		received?: number
		totalSize?: number | null
		error?: string
	} | null
	if (!statusResponse.ok || !status?.ok) {
		throw new Error(status?.error || `Voice upload status failed (${statusResponse.status})`)
	}
	if (status.complete) {
		onProgress?.(1)
		return fragmentHash
	}
	if (status.totalSize != null && status.totalSize !== totalSize) {
		throw new Error('Voice upload resume conflict. Please record again.')
	}

	let offset = Math.min(Math.max(0, status.received ?? 0), totalSize)
	while (offset < totalSize) {
		const chunk = payloadBytes.subarray(offset, Math.min(offset + VOICE_CHUNK_BYTES, totalSize))
		const form = new FormData()
		form.append('wallet', wallet.address)
		form.append('signMessage', signMessage)
		form.append('hash', fragmentHash)
		form.append('totalSize', String(totalSize))
		form.append('offset', String(offset))
		form.append('chunk', new Blob([chunk]), 'voice-fragment.chunk')
		const response = await fetch(`${IPFS_API}/storageFragmentChunk`, {
			method: 'POST',
			body: form,
		})
		const result = (await response.json().catch(() => null)) as {
			ok?: boolean
			received?: number
			error?: string
		} | null
		if (!response.ok || !result?.ok) {
			if (response.status >= 500 && dataUrl.length <= VOICE_DIRECT_UPLOAD_MAX_DATA_URL_CHARS) {
				const directResponse = await fetch(`${IPFS_API}/storageFragment`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						wallet: wallet.address,
						signMessage,
						image: dataUrl,
					}),
				})
				const directBody = (await directResponse.json().catch(() => null)) as {
					error?: string
				} | null
				if (directResponse.ok && !directBody?.error) {
					onProgress?.(1)
					return fragmentHash
				}
				throw new Error(directBody?.error || `Voice direct upload failed (${directResponse.status})`)
			}
			throw new Error(result?.error || `Voice upload failed (${response.status})`)
		}
		offset = Math.min(Number(result.received ?? offset + chunk.length), totalSize)
		onProgress?.(totalSize > 0 ? offset / totalSize : 1)
	}
	return fragmentHash
}

export async function decryptVoiceFragment(
	manifest: VoiceMessageManifest,
	signal?: AbortSignal,
): Promise<Blob> {
	// At most two media downloads at once; decode + decrypt run in the chat
	// media worker (the main thread only receives the response as a Blob).
	return runChatMediaTask(async () => {
		const result = await fetchAndDecryptFragment(
			`${IPFS_API}/getFragment?hash=${encodeURIComponent(manifest.fragmentHash)}`,
			{ method: 'GET', cache: 'no-store', signal },
			manifest.key,
			manifest.iv,
			false,
			'Voice message is unavailable',
		)
		if (result.kind !== 'plain') throw new Error('Voice message is unavailable')
		return new Blob([result.plain], { type: manifest.mime || 'audio/webm' })
	}, signal)
}

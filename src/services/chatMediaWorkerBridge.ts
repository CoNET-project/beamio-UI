/**
 * Chat media download + decrypt: the real module worker wired into
 * chatMediaBridgeCore (timeouts, recoverable failure, counters).
 */

import { decryptFragmentCipher, fragmentBodyToCipher, type FragmentResult } from '../utils/mediaFragment'
import { createChatMediaBridge, MediaTimeoutError, type WorkerLike } from './chatMediaBridgeCore'

const yieldToUi = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/** Main-thread fallback: sliced base64 decode and sliced unzip, yielding between slices. */
async function decryptOnMainThread(body: Blob, isText: boolean, key: string, iv: string, unzip: boolean): Promise<FragmentResult> {
	const cipher = await fragmentBodyToCipher(body, isText, yieldToUi)
	return decryptFragmentCipher(cipher, key, iv, unzip, yieldToUi)
}

const bridge = createChatMediaBridge({
	createWorker: () => new Worker(new URL('../workers/chatMedia/entry.ts', import.meta.url), { type: 'module', name: 'beamio-chat-media' }) as unknown as WorkerLike,
	fallback: decryptOnMainThread,
})

export const decryptFragmentBody = bridge.decryptFragmentBody

/** Which path served the requests so far (worker vs main-thread fallback, timeouts). */
export const getChatMediaStats = bridge.stats

/** Whole download (headers + body). A stalled download used to hold a slot forever. */
export const MEDIA_DOWNLOAD_TIMEOUT_MS = 120_000

/** Fetch a fragment as a Blob (no main-thread text decode) and decrypt it. */
export async function fetchAndDecryptFragment(
	url: string,
	init: RequestInit,
	key: string,
	iv: string,
	unzip: boolean,
	unavailableMessage: string,
): Promise<FragmentResult> {
	const controller = new AbortController()
	const outer = init.signal
	const forwardAbort = () => controller.abort()
	if (outer?.aborted) controller.abort()
	else outer?.addEventListener('abort', forwardAbort, { once: true })
	let timedOut = false
	const timer = setTimeout(() => { timedOut = true; controller.abort() }, MEDIA_DOWNLOAD_TIMEOUT_MS)
	try {
		const response = await fetch(url, { ...init, signal: controller.signal })
		if (!response.ok) throw new Error(unavailableMessage)
		const isText = (response.headers.get('content-type') || '').includes('text')
		const body = await response.blob()
		clearTimeout(timer)
		return await decryptFragmentBody(body, isText, key, iv, unzip)
	} catch (error) {
		if (timedOut) throw new MediaTimeoutError()
		throw error
	} finally {
		clearTimeout(timer)
		outer?.removeEventListener('abort', forwardAbort)
	}
}

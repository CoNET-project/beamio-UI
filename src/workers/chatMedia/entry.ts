/**
 * Off-main-thread chat media: base64 Data URL decode, AES-GCM decrypt, unzip.
 * A 20 MB video blocked the main thread for hundreds of ms when this ran there.
 */
import '../../utils/webSocketGuard'  // WebSocket refusal (project rule): first, before any module that may use it

import { decryptFragmentCipher, fragmentBodyToCipher } from '../../utils/mediaFragment'
import type { ChatMediaWorkerRequest, ChatMediaWorkerResponse } from './protocol'

// eslint-disable-next-line no-restricted-globals -- Worker entry (same pattern as argon2 / appDaemon)
const ctx = self as unknown as {
	postMessage: (message: ChatMediaWorkerResponse, transfer?: Transferable[]) => void
	onmessage: ((ev: MessageEvent<ChatMediaWorkerRequest>) => void) | null
}

ctx.onmessage = (ev: MessageEvent<ChatMediaWorkerRequest>) => {
	const msg = ev.data
	if (!msg || msg.type !== 'decrypt-fragment') return
	const { reqId } = msg
	void (async () => {
		try {
			const cipher = await fragmentBodyToCipher(msg.body, msg.isText, null)
			const result = await decryptFragmentCipher(cipher, msg.key, msg.iv, msg.unzip)
			if (result.kind === 'plain') {
				ctx.postMessage({ type: 'decrypt-result', reqId, ok: true, kind: 'plain', plain: result.plain }, [result.plain])
			} else {
				ctx.postMessage({ type: 'decrypt-result', reqId, ok: true, kind: 'files', files: result.files }, Object.values(result.files))
			}
		} catch (error) {
			ctx.postMessage({ type: 'decrypt-result', reqId, ok: false, error: error instanceof Error ? error.message : String(error) })
		}
	})()
}

ctx.postMessage({ type: 'ready' })

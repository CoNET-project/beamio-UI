/**
 * Worker side of the account signature requests (see signer.ts). The worker posts `signRequest`; the host answers with
 * `signResponse`. The worker never holds the key. A request the host never answers fails after the timeout, so a stuck
 * host cannot hang the worker.
 */
import type { AccountSignRequest } from '../signer.js'
import type { WorkerSignRequest, WorkerSignResponse } from '../protocol.js'

export const WORKER_SIGN_TIMEOUT_MS = 60_000

export interface WorkerSignRelay {
	/** Asks the host for one signature. Rejects with a short code when refused, malformed or timed out. */
	request(request: AccountSignRequest): Promise<string>
	/** Feeds one `signResponse` from the host. Unknown or late answers are ignored. */
	onResponse(msg: WorkerSignResponse): void
}

export function createWorkerSignRelay(
	post: (msg: WorkerSignRequest) => void,
	timeoutMs: number = WORKER_SIGN_TIMEOUT_MS,
): WorkerSignRelay {
	let seq = 1
	const pending = new Map<number, { resolve: (sig: string) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>()
	return {
		request(request: AccountSignRequest): Promise<string> {
			const reqId = seq++
			return new Promise<string>((resolve, reject) => {
				const timer = setTimeout(() => {
					if (!pending.delete(reqId)) return
					reject(new Error('account_sign_timeout'))
				}, timeoutMs)
				pending.set(reqId, { resolve, reject, timer })
				try {
					post({ type: 'signRequest', reqId, request })
				} catch {
					clearTimeout(timer)
					pending.delete(reqId)
					reject(new Error('account_sign_post_failed'))
				}
			})
		},
		onResponse(msg: WorkerSignResponse): void {
			const p = pending.get(msg.reqId)
			if (!p) return
			pending.delete(msg.reqId)
			clearTimeout(p.timer)
			if (msg.ok === true && typeof msg.signature === 'string' && /^0x[0-9a-fA-F]+$/.test(msg.signature)) {
				p.resolve(msg.signature)
			} else {
				p.reject(new Error(typeof msg.error === 'string' && msg.error ? msg.error : 'account_sign_refused'))
			}
		},
	}
}

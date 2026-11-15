/**
 * Chat media worker bridge (testable core: the worker factory and timers are
 * injected; chatMediaWorkerBridge.ts wires the real module worker).
 *
 * - Each request has its own timeout. A worker that hangs without an error used
 *   to leave the bubble spinning and hold one of the two download slots.
 * - A worker failure (did not start, crashed, timed out) is not permanent: the
 *   next request after a back-off (30 s, doubling, max 5 min) starts a new one.
 *   Meanwhile requests use the main-thread fallback (sliced decode + unzip).
 * - Counters (stats) show which path served each request.
 */

import type { FragmentResult } from '../utils/mediaFragment'
import type { ChatMediaWorkerRequest, ChatMediaWorkerResponse } from '../workers/chatMedia/protocol'

export type WorkerLike = {
	postMessage(message: ChatMediaWorkerRequest): void
	terminate(): void
	onmessage: ((ev: { data: ChatMediaWorkerResponse }) => void) | null
	onerror: ((ev: { message?: string }) => void) | null
}

export type Fallback = (body: Blob, isText: boolean, key: string, iv: string, unzip: boolean) => Promise<FragmentResult>

export type ChatMediaBridgeOptions = {
	createWorker: () => WorkerLike
	fallback: Fallback
	readyTimeoutMs?: number
	/** Per-request timeout for a body of `bytes`. */
	requestTimeoutMs?: (bytes: number) => number
	retryBaseMs?: number
	retryMaxMs?: number
	now?: () => number
	setTimer?: (cb: () => void, ms: number) => unknown
	clearTimer?: (handle: unknown) => void
	log?: (message: string) => void
}

export class MediaTimeoutError extends Error {
	constructor() {
		super('Media took too long to prepare. Tap to try again later.')
		this.name = 'TimeoutError'
	}
}

class WorkerStoppedError extends Error {
	constructor(reason: string) {
		super(`chat media worker stopped: ${reason}`)
		this.name = 'WorkerStoppedError'
	}
}

export const defaultRequestTimeoutMs = (bytes: number) => 15_000 + Math.ceil(bytes / (1024 * 1024)) * 1_000

export function createChatMediaBridge(opts: ChatMediaBridgeOptions) {
	const now = opts.now ?? (() => Date.now())
	const setTimer = opts.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms))
	const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
	const readyTimeoutMs = opts.readyTimeoutMs ?? 8_000
	const requestTimeoutMs = opts.requestTimeoutMs ?? defaultRequestTimeoutMs
	const retryBaseMs = opts.retryBaseMs ?? 30_000
	const retryMaxMs = opts.retryMaxMs ?? 300_000
	const log = opts.log ?? ((m: string) => console.warn(`[chatMediaWorker] ${m}`))

	let worker: WorkerLike | null = null
	let readyTimer: unknown
	let failures = 0
	let retryAt = 0
	let nextReqId = 1
	const pending = new Map<number, { resolve: (r: FragmentResult) => void; reject: (e: Error) => void; timer: unknown }>()
	const stats = { workerStarts: 0, workerReady: 0, workerFailures: 0, workerRequests: 0, workerOk: 0, fallbackRequests: 0, timeouts: 0 }

	function stopWorker(reason: string) {
		if (readyTimer !== undefined) clearTimer(readyTimer)
		readyTimer = undefined
		const w = worker
		worker = null
		try { w?.terminate() } catch { /* ignore */ }
		for (const [id, p] of pending) {
			clearTimer(p.timer)
			pending.delete(id)
			p.reject(new WorkerStoppedError(reason))
		}
	}

	function failWorker(reason: string) {
		if (!worker) return
		failures += 1
		stats.workerFailures += 1
		const backoff = Math.min(retryMaxMs, retryBaseMs * 2 ** (failures - 1))
		retryAt = now() + backoff
		log(`unavailable (${reason}); main-thread fallback, retry in ${Math.round(backoff / 1000)} s`)
		stopWorker(reason)
	}

	function ensureWorker(): WorkerLike | null {
		if (worker) return worker
		if (now() < retryAt) return null
		let w: WorkerLike
		try {
			w = opts.createWorker()
		} catch (error) {
			failures += 1
			stats.workerFailures += 1
			retryAt = now() + Math.min(retryMaxMs, retryBaseMs * 2 ** (failures - 1))
			log(`could not start (${error instanceof Error ? error.message : String(error)}); main-thread fallback`)
			return null
		}
		worker = w
		stats.workerStarts += 1
		w.onmessage = ev => {
			const msg = ev.data
			if (!msg || typeof msg !== 'object' || worker !== w) return
			if (msg.type === 'ready') {
				if (readyTimer !== undefined) clearTimer(readyTimer)
				readyTimer = undefined
				failures = 0
				stats.workerReady += 1
				return
			}
			if (msg.type !== 'decrypt-result') return
			const p = pending.get(msg.reqId)
			if (!p) return
			pending.delete(msg.reqId)
			clearTimer(p.timer)
			if (!msg.ok) {
				p.reject(new Error(msg.error || 'media decrypt failed'))
				return
			}
			stats.workerOk += 1
			p.resolve(msg.kind === 'plain' ? { kind: 'plain', plain: msg.plain } : { kind: 'files', files: msg.files })
		}
		w.onerror = ev => { if (worker === w) failWorker(ev?.message || 'worker error') }
		readyTimer = setTimer(() => { if (worker === w) failWorker('ready timed out') }, readyTimeoutMs)
		return w
	}

	async function decryptFragmentBody(body: Blob, isText: boolean, key: string, iv: string, unzip: boolean): Promise<FragmentResult> {
		const w = ensureWorker()
		if (!w) {
			stats.fallbackRequests += 1
			return opts.fallback(body, isText, key, iv, unzip)
		}
		stats.workerRequests += 1
		const reqId = nextReqId++
		try {
			return await new Promise<FragmentResult>((resolve, reject) => {
				const timer = setTimer(() => {
					if (!pending.delete(reqId)) return
					stats.timeouts += 1
					reject(new MediaTimeoutError())
					// A request that never answers means the worker is stuck: replace it.
					if (worker === w) failWorker('request timed out')
				}, requestTimeoutMs(body.size))
				pending.set(reqId, { resolve, reject, timer })
				w.postMessage({ type: 'decrypt-fragment', reqId, body, isText, key, iv, unzip })
			})
		} catch (error) {
			// The worker died mid-request: finish this one on the main thread.
			if (error instanceof WorkerStoppedError) {
				stats.fallbackRequests += 1
				return opts.fallback(body, isText, key, iv, unzip)
			}
			throw error
		}
	}

	return { decryptFragmentBody, stats: () => ({ ...stats, workerAlive: !!worker, retryAt }) }
}

/**
 * The bridge's history load path, without the worker import (extracted so it can run under jest; chatWorkerBridge.ts imports
 * the worker and cannot be loaded there).
 *
 * - before the worker client exists, a load request is queued. Queued requests merge: the later options win when they are given, and
 *   the stronger caller wins (a bypass caller is never hidden by an ordinary one). The queue is flushed by the first request that
 *   arrives when the client is ready.
 * - a ready request goes through the gate (single-flight, interval, numbers-only log; historyLoadGate.ts).
 * - a history buffer batch is counted by the gate and then forwarded to the page's listeners, in that order.
 *
 * The SDK load itself and the client lookup stay in chatWorkerBridge.ts (`runLoad` is injected). SYNTHETIC values only.
 */
import { strongerHistoryCaller, type HistoryLoadCaller, type HistoryLoadGate } from './historyLoadGate'

export interface HistoryLoadPathDeps<O> {
	gate: HistoryLoadGate
	/** One SDK load with the given options. The bridge passes the function that reads the active client. */
	runLoad: (options?: O) => Promise<void>
	/** Called once each time a request is queued because the client is not ready (for the bridge's log line). */
	onQueued?: () => void
}

export interface HistoryLoadPath<O> {
	/**
	 * A load request. `ready` is false while no worker client exists: the request is queued and resolves at once. When ready, the queued
	 * request (if any) is merged into this one and the result goes through the gate.
	 */
	load(options: O | undefined, caller: HistoryLoadCaller, ready: boolean): Promise<void>
	/** Counts the batch's entries in the gate, then forwards the same batch object. */
	deliverBuffer<B extends { entries?: unknown[] } | null | undefined>(batch: B, forward: (batch: B) => void): void
	/** The queued request, or null. For tests and inspection; carries no content. */
	pending(): { caller: HistoryLoadCaller; hasOptions: boolean } | null
}

export function createHistoryLoadPath<O>(deps: HistoryLoadPathDeps<O>): HistoryLoadPath<O> {
	let queued: { options?: O; caller: HistoryLoadCaller } | null = null

	return {
		load(options, caller, ready) {
			if (!ready) {
				const prev = queued
				queued = {
					options: options ?? prev?.options,
					caller: prev ? strongerHistoryCaller(prev.caller, caller) : caller,
				}
				deps.onQueued?.()
				return Promise.resolve()
			}
			const flushed = queued
			queued = null
			const opts = options ?? flushed?.options
			const effective = flushed ? strongerHistoryCaller(flushed.caller, caller) : caller
			return deps.gate.request(effective, () => deps.runLoad(opts))
		},
		deliverBuffer(batch, forward) {
			deps.gate.noteDelivered(Array.isArray(batch?.entries) ? batch!.entries.length : 0)
			forward(batch)
		},
		pending() {
			return queued ? { caller: queued.caller, hasOptions: queued.options !== undefined } : null
		},
	}
}

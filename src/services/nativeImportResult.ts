/**
 * The native import page result (Y.95, §25.52Y.95): `{type: "nativeImportResult", reqId, code, eoa?}`. The page consumes it; the imported
 * key never comes back. `eoa` is present only with `ok` and `already_exists`, and only as a lowercase address; with any other code an
 * `eoa` is not forwarded. A result is accepted only with the reqId of the import this page opened. The page does not enter the app on the
 * result alone: after the result the native wallet is read again with walletStatus (the entry judges the state, Y.95 2).
 */
import { eventPayloadOf, NATIVE_EVENT_NAMES, lastOpenedImportReqId } from './nativeKeyState'

export const NATIVE_IMPORT_RESULT_EVENT = 'nativeImportResult'
export const NATIVE_IMPORT_RESULT_CODES = ['ok', 'already_exists', 'import_failed', 'cancelled', 'bad_request'] as const
export type NativeImportResultCode = (typeof NATIVE_IMPORT_RESULT_CODES)[number]
export type NativeImportResult = { code: NativeImportResultCode; eoa?: string }

const LOWERCASE_EOA = /^0x[0-9a-f]{40}$/

/** Parses one result payload. Null for another type, a different reqId, an unknown code, or no open import. */
export function acceptNativeImportResult(payload: unknown, openedReqId: number | null): NativeImportResult | null {
	if (!payload || typeof payload !== 'object') return null
	const p = payload as { type?: unknown; reqId?: unknown; code?: unknown; eoa?: unknown }
	if (p.type !== NATIVE_IMPORT_RESULT_EVENT) return null
	if (openedReqId === null || Number(p.reqId) !== openedReqId) return null
	if (typeof p.code !== 'string' || !(NATIVE_IMPORT_RESULT_CODES as readonly string[]).includes(p.code)) return null
	const code = p.code as NativeImportResultCode
	if ((code === 'ok' || code === 'already_exists') && typeof p.eoa === 'string' && LOWERCASE_EOA.test(p.eoa)) {
		return { code, eoa: p.eoa }
	}
	// an eoa on any other code, an uppercase or malformed eoa, or none: not forwarded.
	return { code }
}

/** Subscribes to the results of the import this page opened. Returns the unsubscribe function. */
export function onNativeImportResult(listener: (result: NativeImportResult) => void): () => void {
	if (typeof window === 'undefined') return () => undefined
	const handler = (ev: Event) => {
		const accepted = acceptNativeImportResult(eventPayloadOf(ev), lastOpenedImportReqId())
		if (accepted) listener(accepted)
	}
	for (const name of NATIVE_EVENT_NAMES) window.addEventListener(name, handler)
	return () => {
		for (const name of NATIVE_EVENT_NAMES) window.removeEventListener(name, handler)
	}
}

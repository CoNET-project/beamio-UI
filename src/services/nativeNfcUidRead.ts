/**
 * Neutral card read in a native shell (client NFC,  2026-11-13). The page sends `{type, reqId}` only, and the shell
 * answers with the tag's UID and, when the tag provides them, the SUN parameters (e, c, m). The channel has no bind meaning and
 * carries no key material in either direction.
 *
 * PROVISIONAL: the command and event names below are placeholders until the interface owner defines the native spec. Replace
 * them there; nothing else in the page depends on the names.
 *
 * One read is in flight at a time. The result event carries no reqId that the page can match in advance, so the read listens
 * only while it is pending; a late result after the timeout has no listener and is ignored.
 */
import { eventPayloadOf, NATIVE_EVENT_NAMES } from './nativeKeyState'
import { probeNativeCapabilities, requestNativeAck } from './nativeChatRouteRegister'

/** PROVISIONAL command name (no bind semantics). */
export const NATIVE_NFC_UID_READ_COMMAND = 'nfcUidRead'
/** PROVISIONAL result event name. */
export const NATIVE_NFC_UID_RESULT_EVENT = 'nfcUidResult'

const OPEN_TIMEOUT_MS = 10_000
/** A reader waits for the user to tap the card. */
const READ_TIMEOUT_MS = 30_000

export const NFC_UID_RESULT_CODES = [
	'ok',
	'cancelled',
	'no_hardware',
	'disabled',
	'permission_denied',
	'read_failed',
	'invalid_tag',
	'unsupported',
] as const

export type NfcSunParams = { e: string; c: string; m: string }

export type NfcUidReadResult = { ok: true; uid: string; sun?: NfcSunParams } | { ok: false; reason: string }

const UID_RE = /^[0-9a-fA-F]{14}$/
const SUN_E_RE = /^[0-9a-fA-F]{64}$/
const SUN_C_RE = /^[0-9a-fA-F]{6}$/
const SUN_M_RE = /^[0-9a-fA-F]{16}$/

/** Parses a result payload. Returns null for an unknown code, so the caller keeps waiting (nothing is passed on). */
export function parseNfcUidResult(payload: Record<string, unknown>): NfcUidReadResult | null {
	if (payload.type !== NATIVE_NFC_UID_RESULT_EVENT) return null
	const code = payload.code
	if (typeof code !== 'string' || !(NFC_UID_RESULT_CODES as readonly string[]).includes(code)) return null
	if (code !== 'ok') return { ok: false, reason: code }
	const uid = typeof payload.uid === 'string' ? payload.uid.trim().toLowerCase() : ''
	if (!UID_RE.test(uid)) return { ok: false, reason: 'invalid_tag' }
	const hasSun = payload.e !== undefined || payload.c !== undefined || payload.m !== undefined
	if (!hasSun) return { ok: true, uid }
	const e = typeof payload.e === 'string' ? payload.e.trim() : ''
	const c = typeof payload.c === 'string' ? payload.c.trim() : ''
	const m = typeof payload.m === 'string' ? payload.m.trim() : ''
	if (!SUN_E_RE.test(e) || !SUN_C_RE.test(c) || !SUN_M_RE.test(m)) return { ok: false, reason: 'invalid_tag' }
	return { ok: true, uid, sun: { e: e.toLowerCase(), c: c.toLowerCase(), m: m.toLowerCase() } }
}

/**
 * Asks the shell to read the card in front of it and resolves with its UID (and SUN, when present).
 * Resolves `{ok:false, reason}` for a refusal, a cancel, a timeout or a malformed result; never throws.
 */
export async function nativeNfcUidRead(opts?: { timeoutMs?: number }): Promise<NfcUidReadResult> {
	if (typeof window === 'undefined') return { ok: false, reason: 'unsupported' }
	const probe = await probeNativeCapabilities()
	if (!probe.answered) return { ok: false, reason: 'native_unavailable' }

	return new Promise<NfcUidReadResult>((resolve) => {
		let settled = false
		let timer: ReturnType<typeof setTimeout> | undefined
		const finish = (result: NfcUidReadResult) => {
			if (settled) return
			settled = true
			if (timer !== undefined) clearTimeout(timer)
			for (const name of NATIVE_EVENT_NAMES) window.removeEventListener(name, onEvent)
			resolve(result)
		}
		const onEvent = (ev: Event) => {
			const p = eventPayloadOf(ev)
			if (!p) return
			const parsed = parseNfcUidResult(p)
			if (parsed) finish(parsed)
		}
		for (const name of NATIVE_EVENT_NAMES) window.addEventListener(name, onEvent)
		timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), opts?.timeoutMs ?? READ_TIMEOUT_MS)

		void requestNativeAck({ type: NATIVE_NFC_UID_READ_COMMAND }, OPEN_TIMEOUT_MS).then((answer) => {
			if (settled) return
			if (answer.kind !== 'payload') return finish({ ok: false, reason: answer.kind })
			const p = answer.payload as { type?: unknown; ok?: unknown; error?: unknown }
			if (p.type === 'ack' && p.ok === true) return // the card result arrives as an event
			finish({ ok: false, reason: typeof p.error === 'string' && p.error ? p.error : 'unsupported' })
		})
	})
}

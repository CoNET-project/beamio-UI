/**
 * the page side of the native-shell chat send.
 *
 * What it does, in the order the interface fixes:
 *  - capability `send.armorReuse.v1` read from the RAW hello answer (the SDK's known-capability list is not touched); a shell without it takes the old path and its `sent: true` is NEVER a confirmation;
 *  - `sendPrepare` (native signs and encrypts, nothing is posted) -> the page stores the armor (queue document, `armor.record`) and only then `send` carries it (with sendId and armorDigest);
 *  - every retry takes the stored armor back and sends it again: no second encryption (a recipient key change is the one reason to prepare anew);
 *  - the native answer is bound to (sendId, armorDigest) and classified: `bound` (h equals the digest) is the only positive entry proof; an empty 200 is unconfirmed; everything else is a failed attempt;
 *  - the page never releases a queue item here: it only reports the receipt kind (`bound` / `legacy_empty`) the way the browser path does; the release rule (same-sendId proof + a safe sender copy) is the queue's.
 * No key, no armor and no payload is logged; the stage codes are plain words.
 */
import { armorDigest, asPgpMessageArmor, type SendArmorContext, type SendReceipt } from './sendAnswer'

export const NATIVE_SEND_REUSE_CAPABILITY = 'send.armorReuse.v1'
export const NATIVE_SEND_SCHEMA = 1

/** True when the RAW hello answer is a negotiated one that offers `send.armorReuse.v1`. Anything else (no answer, legacy, incompatible) is false: the old path. */
export function nativeSendReuseOf(hello: unknown, negotiated: boolean): boolean {
	if (!negotiated || !hello || typeof hello !== 'object') return false
	const caps = (hello as { capabilities?: unknown }).capabilities
	return Array.isArray(caps) && caps.some((c) => c === NATIVE_SEND_REUSE_CAPABILITY)
}

/** The sendId inside an application wire payload (JSON with a non-empty string `sendId`); null for anything else (then there is nothing to reuse and the old path is taken). */
export function wireSendId(payload: string): string | null {
	try {
		const o = JSON.parse(payload) as { sendId?: unknown }
		return o && typeof o === 'object' && typeof o.sendId === 'string' && o.sendId.trim() ? o.sendId : null
	} catch {
		return null
	}
}

/**
 * (IFACE v1.2): the armored `send` command must CARRY a non-empty `armor` string. `JSON.stringify` drops a key whose value is `undefined`, and a command without the `armor` key is the OLD path: it would silently fall
 * back to the shell signing and encrypting again (a second armor for the same sendId). So the page asserts it BEFORE the command is built, and again on the command as it is serialised. Throws `armor_required`.
 */
export function assertArmorSendCommand(command: Record<string, unknown>): void {
	const wire = JSON.parse(JSON.stringify(command)) as Record<string, unknown>
	const armor = wire.armor
	const digest = wire.armorDigest
	if (typeof armor !== 'string' || !armor.trim() || typeof digest !== 'string' || !digest || typeof wire.sendId !== 'string' || !wire.sendId) throw new Error('armor_required')
}

export type NativeEntryAnswer =
	| { kind: 'bound'; stored?: boolean; duplicate?: boolean; h?: string; hMatches?: boolean }
	| { kind: 'empty_200' | 'store_failed' | 'unreadable' | 'network_error' | 'timeout' }
	| { kind: 'rejected'; status?: number }
export interface NativeSendAnswer { sendId: string; armorDigest?: string; sent: boolean; entryAnswer?: NativeEntryAnswer; tried?: number }

const ENTRY_KINDS = ['bound', 'empty_200', 'store_failed', 'rejected', 'unreadable', 'network_error', 'timeout']

/** The `result` of a native `send` ack, or null when it is not an answer of this interface (the caller treats null as a failed attempt). */
export function parseNativeSendAnswer(result: unknown): NativeSendAnswer | null {
	if (!result || typeof result !== 'object') return null
	const r = result as Record<string, unknown>
	if (typeof r.sendId !== 'string' || !r.sendId) return null
	if (typeof r.sent !== 'boolean') return null
	const out: NativeSendAnswer = { sendId: r.sendId, sent: r.sent }
	if (typeof r.armorDigest === 'string') out.armorDigest = r.armorDigest
	if (typeof r.tried === 'number') out.tried = r.tried
	const ea = r.entryAnswer
	if (ea && typeof ea === 'object' && ENTRY_KINDS.includes(String((ea as { kind?: unknown }).kind))) {
		const e = ea as Record<string, unknown>
		const kind = String(e.kind)
		if (kind === 'bound') {
			out.entryAnswer = {
				kind: 'bound',
				...(typeof e.stored === 'boolean' ? { stored: e.stored } : {}),
				...(typeof e.duplicate === 'boolean' ? { duplicate: e.duplicate } : {}),
				...(typeof e.h === 'string' ? { h: e.h } : {}),
				...(typeof e.hMatches === 'boolean' ? { hMatches: e.hMatches } : {}),
			}
		} else if (kind === 'rejected') {
			out.entryAnswer = { kind: 'rejected', ...(typeof e.status === 'number' ? { status: e.status } : {}) }
		} else {
			out.entryAnswer = { kind } as NativeEntryAnswer
		}
	}
	return out
}

export type NativeSendVerdict = { ok: true; receipt: SendReceipt } | { ok: false; code: string }

/**
 * The page's verdict on one answer (IFACE 3.2). The answer is bound to this send: another sendId or another armorDigest is dropped. `bound` with h equal to the digest and stored/duplicate is the only
 * positive entry proof; an empty 200 is accepted-but-unconfirmed (awaiting, never released); store_failed, rejected, unreadable, network_error, timeout and a h that is not ours are failed attempts.
 * An answer without `entryAnswer` (an older native on this capability, or a gap) is judged by the legacy `sent`: true is NOT a confirmation (unconfirmed), false is a failure.
 */
export function classifyNativeSendAnswer(answer: NativeSendAnswer | null, expect: { sendId: string; digest: string }): NativeSendVerdict {
	if (!answer) return { ok: false, code: 'native_answer_unreadable' }
	if (answer.sendId !== expect.sendId) return { ok: false, code: 'native_answer_mismatch' }
	if (answer.armorDigest !== undefined && answer.armorDigest.toLowerCase() !== expect.digest.toLowerCase()) return { ok: false, code: 'native_answer_mismatch' }
	const e = answer.entryAnswer
	if (!e) return answer.sent ? { ok: true, receipt: { kind: 'legacy_empty', digest: expect.digest } } : { ok: false, code: 'native_not_sent' }
	switch (e.kind) {
		case 'bound': {
			const positive = e.stored === true || e.duplicate === true
			const hOk = typeof e.h === 'string' && e.h.toLowerCase() === expect.digest.toLowerCase() && e.hMatches !== false
			return positive && hOk ? { ok: true, receipt: { kind: 'bound', digest: expect.digest } } : { ok: false, code: 'native_receipt_mismatch' }
		}
		case 'empty_200':
			return { ok: true, receipt: { kind: 'legacy_empty', digest: expect.digest } }
		default:
			return { ok: false, code: `native_${e.kind}` }
	}
}

/** What the page needs from a native client for this interface (the iOS and the Android clients are the same class, nativeConetChatTransport.ts). */
export interface NativeSendClient {
	sendMessage(to: never, payload: string, opts?: { beamioNoPush?: boolean }): Promise<unknown>
	sendPrepare?(to: never, payload: string, sendId: string): Promise<{ sendId: string; armor: string; armorDigest: string }>
	sendArmored?(to: never, payload: string, input: { sendId: string; armor: string; armorDigest: string; beamioNoPush?: boolean }): Promise<NativeSendAnswer | null>
}

export interface NativeSendInput {
	client: NativeSendClient
	/** `send.armorReuse.v1` was negotiated (nativeSendReuseOf) */
	reuse: boolean
	to: never
	payload: string
	beamioNoPush?: boolean
	/** the queue's armor store for this sendId: the stored armor and the way to persist a new one */
	armor?: SendArmorContext
	/** true when the stored armor is still encrypted to the recipient's current key (a retry may reuse it) */
	matchesRecipient?: (armor: string) => Promise<boolean>
	onReceipt?: (receipt: SendReceipt) => void
	/** plain-word stage codes (QA); never a value */
	stage?: (code: string) => void
}

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * One attempt of a native send. Resolves `{ ok }`; never throws. `ok: true` means the entry accepted the post (a bound receipt or an empty 200: `onReceipt` says which); it is NOT a release.
 */
export async function sendViaNative(input: NativeSendInput): Promise<{ ok: boolean; code?: string }> {
	const stage = input.stage ?? (() => undefined)
	const sendId = wireSendId(input.payload)
	const c = input.client
	const canReuse = input.reuse && !!sendId && !!input.armor && typeof c.sendPrepare === 'function' && typeof c.sendArmored === 'function'
	if (!canReuse) {
		// the old path (an older shell, or a payload with no sendId / no queue): the native layer encrypts and posts; its `sent: true` only says the post was accepted: unconfirmed, never a proof
		try {
			await c.sendMessage(input.to, input.payload, input.beamioNoPush ? { beamioNoPush: true } : undefined)
		} catch (e) {
			stage(`native_error:${errMessage(e).slice(0, 40)}`)
			return { ok: false, code: 'native_error' }
		}
		input.onReceipt?.({ kind: 'legacy_empty', digest: '' })
		return { ok: true }
	}
	const id = sendId as string
	const ctx = input.armor as SendArmorContext
	const prepare = async (): Promise<{ armor: string; digest: string } | { code: string }> => {
		let p: { sendId: string; armor: string; armorDigest: string }
		try {
			p = await (c.sendPrepare as NonNullable<NativeSendClient['sendPrepare']>)(input.to, input.payload, id)
		} catch (e) {
			stage(`native_prepare_failed:${errMessage(e).slice(0, 40)}`)
			return { code: 'native_prepare_failed' }
		}
		if (p.sendId !== id) return { code: 'native_answer_mismatch' }
		const inner = asPgpMessageArmor(p.armor)
		if (!inner) return { code: 'native_armor_invalid' }
		const digest = armorDigest(inner)
		if (String(p.armorDigest).toLowerCase() !== digest.toLowerCase()) return { code: 'native_digest_mismatch' }
		// the armor is stored BEFORE the first request leaves: no stored copy -> nothing is sent
		try {
			await ctx.record(inner, digest)
		} catch {
			stage('armor_not_stored')
			return { code: 'armor_not_stored' }
		}
		return { armor: inner, digest }
	}
	let armor: string
	let digest: string
	let reused = false
	const stored = ctx.armor
	// a blank stored armor is no armor: a new one is prepared (it is never sent: the armored command needs a non-empty armor string, assertArmorSendCommand)
	if (stored && stored.trim() && (input.matchesRecipient ? await input.matchesRecipient(stored).catch(() => false) : true)) {
		// the same sendId again: the armor of the first attempt, byte for byte
		armor = asPgpMessageArmor(stored) ?? stored
		digest = armorDigest(armor)
		reused = true
	} else {
		const p = await prepare()
		if ('code' in p) return { ok: false, code: p.code }
		armor = p.armor
		digest = p.digest
	}
	const attempt = async (): Promise<NativeSendVerdict | { retryPrepare: true }> => {
		let answer: NativeSendAnswer | null
		try {
			answer = await (c.sendArmored as NonNullable<NativeSendClient['sendArmored']>)(input.to, input.payload, { sendId: id, armor, armorDigest: digest, ...(input.beamioNoPush ? { beamioNoPush: true } : {}) })
		} catch (e) {
			const m = errMessage(e)
			// the native layer refused the stored armor itself: ONE re-prepare below, then a plain failure
			if (reused && (m.includes('armor_invalid') || m.includes('armor_digest_mismatch'))) return { retryPrepare: true }
			stage(`native_error:${m.slice(0, 40)}`)
			return { ok: false, code: 'native_error' }
		}
		return classifyNativeSendAnswer(answer, { sendId: id, digest })
	}
	let verdict = await attempt()
	if ('retryPrepare' in verdict) {
		const p = await prepare()
		if ('code' in p) return { ok: false, code: p.code }
		armor = p.armor
		digest = p.digest
		reused = false
		verdict = await attempt()
		if ('retryPrepare' in verdict) return { ok: false, code: 'native_error' }
	}
	if (!verdict.ok) {
		stage(verdict.code)
		return { ok: false, code: verdict.code }
	}
	input.onReceipt?.(verdict.receipt)
	return { ok: true }
}

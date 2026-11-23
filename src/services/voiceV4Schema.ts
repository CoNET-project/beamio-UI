/**
 * Key schema of the v4 pre-connection signals (v122 §141, v121 §140): any undefined key is refused.
 * - offer v4: no callerPgp, callerRoute, callerTag, callerSignature. Channels cv/cV: sid,key,wk,temp,tempPgpFpr,tempPgpArmor?,auth.
 * - accept v4: no codec, no timestamp. Channels ev/eV as above; pays cv_pay, cV_pay, ev_pay, eV_pay: role,temp,notAfter,maxBytes,maxSeconds,sig (no payer).
 * - auth: exactly from, validUntil, sig.
 * - reject.reason: declined | busy.
 */

const OFFER_KEYS = ['type', 'proto', 'callId', 'sessionId', 'from', 'to', 'codec', 'createdAt', 'expiresAt', 'timestamp', 'cv', 'cV', 'sig'] as const
const ACCEPT_KEYS = ['type', 'proto', 'callId', 'sessionId', 'from', 'to', 'createdAt', 'expiresAt', 'ev', 'eV', 'cv_pay', 'cV_pay', 'ev_pay', 'eV_pay', 'sig'] as const
const CHANNEL_KEYS = ['sid', 'key', 'wk', 'temp', 'tempPgpFpr', 'tempPgpArmor', 'auth'] as const
const AUTH_KEYS = ['from', 'validUntil', 'sig'] as const
const PAY_KEYS = ['role', 'temp', 'notAfter', 'maxBytes', 'maxSeconds', 'sig'] as const

const onlyKeys = (obj: unknown, allowed: readonly string[], required: readonly string[]): boolean => {
	if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false
	const keys = Object.keys(obj)
	if (keys.some((k) => !allowed.includes(k))) return false
	return required.every((k) => (obj as Record<string, unknown>)[k] !== undefined)
}

const channelOk = (ch: unknown): boolean => onlyKeys(ch, CHANNEL_KEYS, ['sid', 'key', 'wk', 'temp', 'tempPgpFpr', 'auth']) && onlyKeys((ch as { auth: unknown }).auth, AUTH_KEYS, AUTH_KEYS)

/** An offer v4 with exactly the allowed keys, and both channels well-formed. */
export function offerV4SchemaOk(offer: unknown): boolean {
	if (!onlyKeys(offer, OFFER_KEYS, ['type', 'proto', 'callId', 'sessionId', 'from', 'to', 'createdAt', 'expiresAt', 'timestamp', 'cv', 'cV', 'sig'])) return false
	const o = offer as Record<string, unknown>
	return o.proto === 4 && channelOk(o.cv) && channelOk(o.cV)
}

/** The pay object of an accept v4: no payer, role one of the four channels. */
export function payV4SchemaOk(pay: unknown): boolean {
	if (!onlyKeys(pay, PAY_KEYS, PAY_KEYS)) return false
	return ['cv', 'cV', 'ev', 'eV'].includes((pay as { role: unknown }).role as string)
}

/** An accept v4 with exactly the allowed keys, both channels and the four pays. */
export function acceptV4SchemaOk(accept: unknown): boolean {
	if (!onlyKeys(accept, ACCEPT_KEYS, ['type', 'proto', 'callId', 'sessionId', 'from', 'to', 'createdAt', 'expiresAt', 'ev', 'eV', 'cv_pay', 'cV_pay', 'ev_pay', 'eV_pay', 'sig'])) return false
	const a = accept as Record<string, unknown>
	return a.proto === 4 && channelOk(a.ev) && channelOk(a.eV) && payV4SchemaOk(a.cv_pay) && payV4SchemaOk(a.cV_pay) && payV4SchemaOk(a.ev_pay) && payV4SchemaOk(a.eV_pay)
}

/** The reject reason: declined or busy only. Missing or any other value is refused. */
export function rejectReasonOk(reason: unknown): boolean {
	return reason === 'declined' || reason === 'busy'
}

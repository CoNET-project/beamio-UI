/**
 * Voice protocol v4 canonical texts and digests.
 * Pure functions: no key material. Times are in milliseconds, except the pay notAfter (seconds).
 */
import { ethers } from 'ethers'

export type V4Role = 'cv' | 'cV' | 'ev' | 'eV'

/** One channel object (offer cv/cV, accept ev/eV). `tempPgpArmor` is omitted when the channel has no user-side PGP. */
export type V4Channel = {
	sid: string
	key: string
	wk: string
	temp: string
	tempPgpFpr: string
	tempPgpArmor?: string
	/** The authorization {from, validUntil, sig} only. The fingerprint is the top-level `tempPgpFpr`. */
	auth: { from: string; validUntil: number; sig: string }
}

/** One pay: the callee's payment authorization for a channel. */
export type V4Pay = { role: V4Role; temp: string; notAfter: number; maxBytes: number; maxSeconds: number; sig: string }

const sha256Hex = (text: string): string => ethers.sha256(ethers.toUtf8Bytes(text)).slice(2).toLowerCase()

/** SHA-256 hex of the armor text (UTF-8); '' when there is no armor. */
export const armorSha256 = (armor: string | undefined): string => (armor ? sha256Hex(armor) : '')

/** chansDigest: one line per channel in the given order, joined by \n with no trailing newline. */
export function chansDigest(role: [V4Role, V4Role], channels: [V4Channel, V4Channel]): string {
	const lines = channels.map((c, i) =>
		[
			`role:${role[i]}`,
			`sid:${c.sid}`,
			`key:${c.key}`,
			`wk:${c.wk}`,
			`temp:${c.temp.toLowerCase()}`,
			`tempPgpFpr:${c.tempPgpFpr.toLowerCase()}`,
			`armorSha256:${armorSha256(c.tempPgpArmor)}`,
		].join(' '),
	)
	return sha256Hex(lines.join('\n'))
}

/** payDigest: one line per pay, in the order cv, cV, ev, eV, joined by \n with no trailing newline. */
export function payDigest(pays: V4Pay[]): string {
	const lines = pays.map((p) =>
		[`role:${p.role}`, `temp:${p.temp.toLowerCase()}`, `notAfter:${p.notAfter}`, `maxBytes:${p.maxBytes}`, `maxSeconds:${p.maxSeconds}`, `sig:${p.sig}`].join(' '),
	)
	return sha256Hex(lines.join('\n'))
}

/** offer v4 canonical. timestamp is the same value as createdAt. */
export function offerV4Text(f: {
	callId: string
	sessionId: string
	from: string
	to: string
	createdAt: number
	expiresAt: number
	codec: string
	chansDigest: string
}): string {
	return [
		'CoNET voice_call_offer_v4',
		`callId:${f.callId}`,
		`sessionId:${f.sessionId}`,
		`from:${f.from.toLowerCase()}`,
		`to:${f.to.toLowerCase()}`,
		`createdAt:${f.createdAt}`,
		`expiresAt:${f.expiresAt}`,
		`timestamp:${f.createdAt}`,
		`codec:${f.codec}`,
		`chansDigest:${f.chansDigest}`,
	].join('\n')
}

/** accept v4 canonical. offerSigSha256 is the SHA-256 hex of the offer's sig text (with 0x). */
export function acceptV4Text(f: {
	callId: string
	sessionId: string
	from: string
	to: string
	offerSig: string
	chansDigest: string
	payDigest: string
	createdAt: number
	expiresAt: number
}): string {
	return [
		'CoNET voice_call_accept_v4',
		`callId:${f.callId}`,
		`sessionId:${f.sessionId}`,
		`from:${f.from.toLowerCase()}`,
		`to:${f.to.toLowerCase()}`,
		`offerSigSha256:${sha256Hex(f.offerSig.toLowerCase())}`,
		`chansDigest:${f.chansDigest}`,
		`payDigest:${f.payDigest}`,
		`createdAt:${f.createdAt}`,
		`expiresAt:${f.expiresAt}`,
	].join('\n')
}

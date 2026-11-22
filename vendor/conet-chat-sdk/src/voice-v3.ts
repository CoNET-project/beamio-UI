/**
 * Voice protocol v3: paid temporary SSE channels.
 *
 * The callee creates four channels when it answers (caller voice, caller
 * video, callee voice, callee video). Each channel has its own temporary
 * wallet T, AES key, write key and 16-byte locator. A payer wallet signs T
 * (`voicePayText`); T signs every `voice_listen` (`voiceListenText`) bound to
 * the relay's route key ID. The relay checks both signatures and `notAfter`.
 *
 * The caller picks the relay for its own two channels, the callee for its own
 * two. The callee hands the caller its two channels (T private key included)
 * inside the accept, which is a normal recipient-PGP chat message.
 *
 * Must match CoNET-SI `voiceForward.ts` (voicePayText / voiceListenText).
 */
import { ethers } from 'ethers'
import type { AccountSigning } from './signer.js'
import { base64ToBytes, bytesToBase64 } from './voice-channel-v2.js'

/** How long a payment signature stays valid (covers reconnects in a long call). */
export const VOICE_PAY_VALID_SEC = 12 * 60 * 60

export type VoicePayAuth = {
	payer: string
	notAfter: number
	maxBytes: number
	maxSeconds: number
	sig: string
}

/** One channel as the accept carries it. `tk` / `pay` only for channels the receiver opens. */
export type VoiceChannelWire = {
	sid: string
	key: string
	wk: string
	tk?: string
	pay?: VoicePayAuth
	/** Relay route key ID (node domain), its IP and base64 armored route key. */
	relay?: string
	relayIp?: string
	relayKey?: string
}

/** `cv`, `cV`: the caller listens. `ev`, `eV`: the callee listens. */
export type VoiceChannelsWire = {
	cv: VoiceChannelWire
	cV: VoiceChannelWire
	ev: VoiceChannelWire
	eV: VoiceChannelWire
}

/** A channel this side opens (listens on). */
export type VoiceOwnChannel = {
	sid: string
	key: string
	wk: string
	tk: string
	pay: VoicePayAuth
	/** Relay route key ID (node domain). Empty: the worker picks one. */
	relay?: string
}

/** A channel this side sends to. `relay` empty until the owner reports it. */
export type VoicePeerChannel = {
	sid: string
	key: string
	wk: string
	relay?: string
	relayIp?: string
	/** base64 armored route key of the relay (used when our node table lacks it). */
	relayKey?: string
}

/** Everything the chat worker needs to run a v3 call. Memory only. */
export type VoiceCallV3Config = {
	callId: string
	/** AES key the page uses for its own frames; the worker re-keys per channel. */
	uiKey: string
	role: 'caller' | 'callee'
	own: { voice: VoiceOwnChannel; video: VoiceOwnChannel }
	peer: { voice: VoicePeerChannel; video: VoicePeerChannel }
	/** Route keys (armored) of both mailboxes: never used as relay or entry. */
	avoidRoutes: string[]
}

export const voicePayText = (temp: string, notAfter: number, maxBytes: number, maxSeconds: number): string =>
	[
		'conet.voice.sse.pay.v3',
		`temp=${temp.toLowerCase()}`,
		`notAfter=${notAfter}`,
		`maxBytes=${maxBytes}`,
		`maxSeconds=${maxSeconds}`,
	].join('\n')

export const voiceListenText = (sessionId: string, wk: string, relayKeyId: string, timestamp: number): string =>
	['conet.voice.sse.listen.v3', sessionId, wk, relayKeyId.toUpperCase(), String(timestamp)].join('|')

const randomHex = (bytes: number): string =>
	Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('')

/** New channel secrets: 32-hex locator, AES-256 key, HMAC write key. */
export const newVoiceChannelSecrets = (): { sid: string; key: string; wk: string } => ({
	sid: randomHex(16),
	key: bytesToBase64(crypto.getRandomValues(new Uint8Array(32))),
	wk: bytesToBase64(crypto.getRandomValues(new Uint8Array(32))),
})

/** New temporary wallet T and the payer's signature over it. */
export const newPaidVoiceChannel = async (
	payer: Pick<AccountSigning, 'address' | 'signMessage'>,
	nowSec = Math.floor(Date.now() / 1000),
): Promise<VoiceOwnChannel> => {
	const temp = ethers.Wallet.createRandom()
	const notAfter = nowSec + VOICE_PAY_VALID_SEC
	const sig = await payer.signMessage(voicePayText(temp.address, notAfter, 0, 0))
	return {
		...newVoiceChannelSecrets(),
		tk: temp.privateKey,
		pay: { payer: payer.address.toLowerCase(), notAfter, maxBytes: 0, maxSeconds: 0, sig },
	}
}

/** The `voice_listen` v3 command for one own channel on `relayKeyId`. */
export const buildVoiceListenV3 = async (
	channel: VoiceOwnChannel,
	relayKeyId: string,
	nowSec = Math.floor(Date.now() / 1000),
): Promise<Record<string, unknown>> => {
	const temp = new ethers.Wallet(channel.tk)
	return {
		command: 'voice_listen',
		v: 3,
		sessionId: channel.sid,
		wk: channel.wk,
		timestamp: nowSec,
		temp: temp.address,
		tempSig: await temp.signMessage(voiceListenText(channel.sid, channel.wk, relayKeyId, nowSec)),
		pay: channel.pay,
	}
}

const validChannel = (c: unknown, own: boolean): c is VoiceChannelWire => {
	if (!c || typeof c !== 'object') return false
	const ch = c as VoiceChannelWire
	if (!/^[0-9a-f]{32}$/.test(String(ch.sid || ''))) return false
	try {
		if (base64ToBytes(String(ch.key || '')).length !== 32) return false
		if (base64ToBytes(String(ch.wk || '')).length !== 32) return false
	} catch {
		return false
	}
	if (!own) return true
	const pay = ch.pay
	return typeof ch.tk === 'string' && /^0x[0-9a-fA-F]{64}$/.test(ch.tk) &&
		!!pay && typeof pay.sig === 'string' && ethers.isAddress(String(pay.payer || '')) &&
		Number.isSafeInteger(pay.notAfter)
}

/** Shape check of `accept.ch` as the caller receives it. */
export const parseVoiceChannelsWire = (raw: unknown): VoiceChannelsWire | null => {
	if (!raw || typeof raw !== 'object') return null
	const ch = raw as VoiceChannelsWire
	if (!validChannel(ch.cv, true) || !validChannel(ch.cV, true)) return null
	if (!validChannel(ch.ev, false) || !validChannel(ch.eV, false)) return null
	if (!ch.ev.relay || !ch.eV.relay) return null
	return ch
}

/** A short random AES key for the page's own frames (never leaves this device). */
export const newVoiceUiKey = (): string => bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))

// ---------------------------------------------------------------------------
// Alternative A: each channel's temporary wallet is generated
// by the party that uses it, with a CSPRNG, and never leaves that device. Messages
// carry only the temporary ADDRESS and an authorization signed by the channel's
// user EOA. The private key (tk) is never sent, not even encrypted.
// ---------------------------------------------------------------------------

/** The channel labels of the caller listens on cv/cV, the callee on ev/eV. */
export type VoiceChannelLabel = 'cv' | 'cV' | 'ev' | 'eV'

/**
 * The authorization a channel user's EOA signs over a temporary address.
 * `validUntil` is in MILLISECONDS (the same unit as Date.now() and the offer's expiresAt in ms); the pay's notAfter is in seconds.
 */
export type VoiceChannelAuth = {
	from: string
	validUntil: number
	sig: string
}

/**
 * A temporary wallet for one channel, created here by a CSPRNG (ethers createRandom
 * uses crypto random bytes). `privateKey` stays in memory on this device; only
 * `address` may be sent.
 */
export const newTemporaryChannelWallet = (): { address: string; privateKey: string } => {
	const temp = ethers.Wallet.createRandom()
	return { address: temp.address, privateKey: temp.privateKey }
}

/** The canonical text the channel user's EOA signs. */
export const voiceAuthText = (f: {
	callId: string
	sessionId: string
	channel: VoiceChannelLabel
	temp: string
	/** The temporary PGP public key fingerprint (lower-case hex), or '' when the channel has no user-side PGP. */
	tempPgpFpr: string
	from: string
	validUntil: number
}): string =>
	[
		'CoNET voice_pgp_auth_v1',
		`callId:${f.callId}`,
		`sessionId:${f.sessionId}`,
		`channel:${f.channel}`,
		`temp:${f.temp.toLowerCase()}`,
		`tempPgpFpr:${f.tempPgpFpr.toLowerCase()}`,
		`from:${f.from.toLowerCase()}`,
		`validUntil:${f.validUntil}`,
	].join('\n')

/**
 * The channel user signs the authorization. The auth object is {from, validUntil, sig} only: the fingerprint
 * `tempPgpFpr` is the channel's top-level field, rebuilt by the verifier into the canonical text.
 */
export const signVoiceAuth = async (
	signer: Pick<AccountSigning, 'address' | 'signMessage'>,
	f: { callId: string; sessionId: string; channel: VoiceChannelLabel; temp: string; tempPgpFpr?: string; validUntil: number },
): Promise<VoiceChannelAuth> => {
	const from = signer.address.toLowerCase()
	const fields = { ...f, tempPgpFpr: f.tempPgpFpr ?? '', from }
	const sig = await signer.signMessage(voiceAuthText(fields))
	return { from, validUntil: f.validUntil, sig }
}

/**
 * Verifies an authorization: the signature must recover `from`, `from` must be the expected
 * user EOA, `validUntil` must not have passed (`nowMs`, default Date.now()), and `validUntil` must not be later than the offer's
 * `expiresAt` (also ms). Returns false otherwise (the caller drops the message silently).
 */
export const verifyVoiceAuth = (
	auth: VoiceChannelAuth | null | undefined,
	/** The channel's top-level fields; `tempPgpFpr` is the value the canonical is rebuilt with. */
	f: { callId: string; sessionId: string; channel: VoiceChannelLabel; temp: string; tempPgpFpr: string },
	expectedFrom: string,
	nowMs: number = Date.now(),
	/** The offer's expiresAt in ms: a validUntil later than this is refused. */
	expiresAtMs?: number,
): boolean => {
	if (!auth || typeof auth.sig !== 'string' || typeof auth.from !== 'string') return false
	// auth carries exactly {from, validUntil, sig}: any other field is refused.
	const keys = Object.keys(auth).sort().join(',')
	if (keys !== 'from,sig,validUntil') return false
	// The fingerprint is lower-case 40-hex, or the empty placeholder. No normalisation: anything else is refused.
	if (typeof f.tempPgpFpr !== 'string' || (f.tempPgpFpr !== '' && !/^[0-9a-f]{40}$/.test(f.tempPgpFpr))) return false
	if (!Number.isSafeInteger(auth.validUntil) || auth.validUntil < nowMs) return false
	if (expiresAtMs !== undefined && auth.validUntil > expiresAtMs) return false
	if (auth.from.toLowerCase() !== expectedFrom.toLowerCase()) return false
	try {
		const recovered = ethers.verifyMessage(
			voiceAuthText({ ...f, from: auth.from, validUntil: auth.validUntil }),
			auth.sig,
		)
		return recovered.toLowerCase() === auth.from.toLowerCase()
	} catch {
		return false
	}
}

export const verifyVoicePayFor = (
	pay: VoicePayAuth | null | undefined,
	temp: string,
	expectedPayer: string,
	nowSec = Math.floor(Date.now() / 1000),
): boolean => {
	if (!pay || typeof pay.sig !== 'string' || typeof pay.payer !== 'string') return false
	if (pay.payer.toLowerCase() !== expectedPayer.toLowerCase()) return false
	if (!Number.isSafeInteger(pay.notAfter) || pay.notAfter <= nowSec) return false
	try {
		const recovered = ethers.verifyMessage(
			voicePayText(temp, pay.notAfter, pay.maxBytes, pay.maxSeconds),
			pay.sig,
		)
		return recovered.toLowerCase() === expectedPayer.toLowerCase()
	} catch {
		return false
	}
}

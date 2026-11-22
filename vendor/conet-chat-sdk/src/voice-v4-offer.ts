/**
 * Caller side of voice protocol v4.
 * The caller creates cv and cV before it sends the offer: per channel a CSPRNG locator/key/write-key, a temporary
 * wallet T, a temporary OpenPGP key (decision 5a676140), and the account's voice_pgp_auth_v1 authorization.
 * Temporary secrets stay in memory; only the public fields go into the offer.
 */
import { ethers } from 'ethers'
import type { AccountSigning } from './signer.js'
import { newTemporaryPgpKey, forgetTemporaryPgpKey, tempPgpArmorMatchesFingerprint, type TemporaryPgpKey } from './voice-temp-pgp.js'
import { newVoiceChannelSecrets, newTemporaryChannelWallet, signVoiceAuth, verifyVoiceAuth, type VoiceChannelLabel } from './voice-v3.js'
import { chansDigest, offerV4Text, type V4Channel } from './voice-v4.js'

/** A caller channel: the offer's public part, plus the private parts kept on this device. */
export type CallerV4Channel = {
	/** The public object carried in the offer (cv or cV). */
	public: V4Channel
	/** Private: the temporary wallet key and the temporary PGP key. Never sent; cleared when the call ends. */
	secret: { tempPrivateKey: string; pgp: TemporaryPgpKey }
}

/** Creates one caller channel for `label` (cv or cV). The authorization is signed by the account (`from`). */
export async function newCallerV4Channel(
	signer: Pick<AccountSigning, 'address' | 'signMessage'>,
	f: { callId: string; sessionId: string; label: 'cv' | 'cV'; validUntil: number },
): Promise<CallerV4Channel> {
	const secrets = newVoiceChannelSecrets()
	const wallet = newTemporaryChannelWallet()
	const pgp = await newTemporaryPgpKey()
	const auth = await signVoiceAuth(signer, {
		callId: f.callId,
		sessionId: f.sessionId,
		channel: f.label as VoiceChannelLabel,
		temp: wallet.address,
		tempPgpFpr: pgp.fingerprint,
		validUntil: f.validUntil,
	})
	return {
		public: {
			sid: secrets.sid,
			key: secrets.key,
			wk: secrets.wk,
			temp: wallet.address.toLowerCase(),
			tempPgpFpr: pgp.fingerprint,
			tempPgpArmor: pgp.publicArmor,
			auth,
		},
		secret: { tempPrivateKey: wallet.privateKey, pgp },
	}
}

/** Clears the private parts of a caller channel (the call ends, or the offer is abandoned). */
export function forgetCallerV4Channel(ch: CallerV4Channel): void {
	forgetTemporaryPgpKey(ch.secret.pgp)
	ch.secret.tempPrivateKey = ''
}

/** Signs the offer v4 canonical (`sig`, EIP-191 by `from`) over the chansDigest of [cv, cV]. */
export async function signOfferV4(
	signer: Pick<AccountSigning, 'address' | 'signMessage'>,
	f: { callId: string; sessionId: string; to: string; createdAt: number; expiresAt: number; codec: string },
	cv: V4Channel,
	cV: V4Channel,
): Promise<{ from: string; sig: string; chansDigest: string }> {
	const from = signer.address.toLowerCase()
	const digest = chansDigest(['cv', 'cV'], [cv, cV])
	const text = offerV4Text({ ...f, from, chansDigest: digest })
	const sig = await signer.signMessage(text)
	return { from, sig, chansDigest: digest }
}

/**
 * Verifies a received offer v4: the signature recovers `from`; `to` is the local account; timestamp equals
 * createdAt; not expired; the chansDigest recomputes; each channel's authorization and armor fingerprint hold.
 * Returns false otherwise (the caller drops the offer silently).
 */
export async function verifyOfferV4(
	offer: {
		callId: string; sessionId: string; from: string; to: string; createdAt: number; expiresAt: number; timestamp: number; codec: string
		sig: string; cv: V4Channel; cV: V4Channel
	},
	localAccount: string,
	nowMs: number = Date.now(),
): Promise<boolean> {
	if (offer.timestamp !== offer.createdAt) return false
	// Shape guard before any string operation (chansDigest lower-cases tempPgpFpr): a missing or non-string fingerprint drops the offer.
	for (const ch of [offer.cv, offer.cV]) {
		if (!ch || typeof ch.tempPgpFpr !== 'string' || typeof ch.temp !== 'string' || typeof ch.sid !== 'string' || typeof ch.key !== 'string' || typeof ch.wk !== 'string') return false
	}
	if (offer.expiresAt <= nowMs) return false
	if (offer.to.toLowerCase() !== localAccount.toLowerCase()) return false
	const digest = chansDigest(['cv', 'cV'], [offer.cv, offer.cV])
	const text = offerV4Text({ ...offer, chansDigest: digest })
	try {
		if (ethers.verifyMessage(text, offer.sig).toLowerCase() !== offer.from.toLowerCase()) return false
	} catch {
		return false
	}
	for (const [label, ch] of [['cv', offer.cv], ['cV', offer.cV]] as const) {
		// The verifier rebuilds the voice_pgp_auth_v1 canonical with the channel's top-level tempPgpFpr and checks the signature
		//. An upper-case or malformed value, or any field in auth beyond {from, validUntil, sig}, is refused inside verifyVoiceAuth.
		if (typeof ch.tempPgpFpr !== 'string') return false
		if (!verifyVoiceAuth(ch.auth, { callId: offer.callId, sessionId: offer.sessionId, channel: label, temp: ch.temp, tempPgpFpr: ch.tempPgpFpr }, offer.from, nowMs, offer.expiresAt)) return false
		// The armor must hash to the same fingerprint, character for character (case K). An empty fingerprint means no armor.
		if (!(await tempPgpArmorMatchesFingerprint(ch.tempPgpArmor, ch.tempPgpFpr))) return false
	}
	return true
}

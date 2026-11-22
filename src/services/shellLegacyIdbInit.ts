/**
 * steps 1 and 2: a shell start reads the old PWA store first. The 0.52.930 format is
 * PouchDB "conet", document "init", title = base64(JSON) of the whole record, with the mnemonic in plain `mnemonicPhrase`.
 * The old store is the route authority for an existing account: a valid mnemonic whose derived address equals profiles[0].keyID enters
 * the account at its address. A mismatch, a read failure or a timeout is unknown (held, never written). An absent document or a
 * document with no mnemonic is confirmed empty; the native path decides then.
 * The derivation here is the one exempt path (24.5 (b)): it reads the page's own stored mnemonic and derives nothing else.
 */
import { ethers } from 'ethers'

type Loose = Record<string, unknown>

export type LegacyInitDecision = { status: 'valid'; eoa: string } | { status: 'absent' } | { status: 'unknown'; reason: 'native_retry' }

/** The EOA of a valid BIP-39 mnemonic (Wallet.fromPhrase: English, empty passphrase, m/44'/60'/0'/0/0), or '' when none is valid. */
export function mnemonicEoa(phrase: unknown): string {
	if (typeof phrase !== 'string' || !phrase.trim()) return ''
	try {
		const address = ethers.Wallet.fromPhrase(phrase.trim()).address
		return /^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : ''
	} catch {
		return ''
	}
}

/**
 * Pure decision on the decoded old record (or null when the document is missing). `unknown` is a hold: the caller returns the wait and
 * writes nothing. A mnemonic that is present but does not derive to profiles[0].keyID is unknown (the store is not used, not changed).
 */
export function decideLegacyInit(data: Loose | null | undefined): LegacyInitDecision {
	if (!data || typeof data !== 'object') return { status: 'absent' }
	const phrase = typeof data.mnemonicPhrase === 'string' ? data.mnemonicPhrase.trim() : ''
	if (!phrase) return { status: 'absent' }
	const eoa = mnemonicEoa(phrase)
	if (!eoa) return { status: 'unknown', reason: 'native_retry' }
	const first = Array.isArray(data.profiles) ? (data.profiles[0] as Loose | undefined) : undefined
	const keyID = first && typeof first.keyID === 'string' ? first.keyID.trim().toLowerCase() : ''
	// rule C (2026-11-17): a PWA-local mnemonic that derives to an address other than keyID is a deterministic "no valid mnemonic" (E7),
	// not an unknown read. It is not used, nothing is written, and the native pre-read (E6) decides: the same as an absent document.
	if (keyID !== eoa) return { status: 'absent' }
	return { status: 'valid', eoa }
}

/**
 * The page copy made from the old PWA store, with every PGP public path the shell write refuses removed (shellRecordSanitizer.pgpPublicPaths):
 * profiles[].pgpKey, profiles[].chatManager.pgpKey, profiles[].chats[].chatData.publicArmored, beamio.pgpPublicKeyID and
 * beamio.pgpPublicKeyArmor. An empty string counts too (the check is on presence). A write that carries any of them is refused, so an
 * old record with a chat peer or a chat key would make every shell save fail. The input is not changed: the old store stays byte for byte.
 */
export function stripLegacyChatContainers(data: Loose): Loose {
	const copy = JSON.parse(JSON.stringify(data)) as Loose
	const visit = (list: unknown): void => {
		if (Array.isArray(list)) {
			for (const x of list) visit(x)
			return
		}
		if (!list || typeof list !== 'object') return
		const p = list as Loose
		delete p.pgpKey
		if (p.chatManager && typeof p.chatManager === 'object') delete (p.chatManager as Loose).pgpKey
		if (Array.isArray(p.chats)) {
			for (const c of p.chats as unknown[]) {
				if (c && typeof c === 'object' && (c as Loose).chatData && typeof (c as Loose).chatData === 'object') {
					delete ((c as Loose).chatData as Loose).publicArmored
				}
			}
		}
	}
	visit(copy.profiles)
	if (copy.beamio && typeof copy.beamio === 'object') {
		delete (copy.beamio as Loose).pgpPublicKeyID
		delete (copy.beamio as Loose).pgpPublicKeyArmor
	}
	return copy
}

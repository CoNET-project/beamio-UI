/**
 * First-contact trust of a key that comes from the chain:
 *
 *   "When the PGP key is pulled from the chain, no notice is needed: a key placed in the contract has been checked by the miner and can be trusted."
 *
 * A first-contact send goes out directly, with no notice, only when ALL THREE hold:
 *  1. the record comes from the AddressPGP contract on the whitelist hard-coded below (chain 224422), as the read itself reports it;
 *  2. the record is the contact's: the address the read was made for is this contact's address;
 *  3. the key that is actually used for encryption is the key the chain record names: the record's `userPgpKeyID` is the key ID of the ENCRYPTION SUBKEY
 *     (measured on the chain for v4 accounts; it is not the primary key's ID), so it is compared with the fingerprint of the encryption key that OpenPGP selects.
 * That fingerprint is then the first pinned value; a later different key is `fingerprint_changed` as before.
 *
 * Everything else is unchanged: a failed or timed-out read, an unknown or non-whitelisted source, a missing record id: hold (`first_fetch_pending`).
 *
 * This is the ONE decision. The send gate (decideTrustedRoute), the receipt-route trust (receiptRouteTrust, via the same decision) and the verification
 * prompt all use it; the native SDKs hold no contact trust rule of their own (they encrypt to the key the page hands them and take the receipt route
 * table the page builds), so there is nothing to keep in step on the native side. The shared vectors are in vectors/firstContactChainTrust.v1.json.
 */

/** The AddressPGP contracts a first-contact key may be trusted from. Hard-coded in the build: it is never read from configuration or from a record. */
export const CHAIN_PGP_WHITELIST: ReadonlyArray<{ readonly chainId: number; readonly contract: string }> = [
	{ chainId: 224422, contract: '0x684b0ac760cEE9c9b85de36d69746420648Cf9e2' },
]

/** Where a record was read from, as the read reports it (set by the chain reader, never by the record's own content). */
export type RecordSource = {
	chainId: number
	/** The AddressPGP contract that answered. */
	contract: string
	/** The address the read was made for (the `to` of searchKey). */
	queriedAddress: string
}

export type ChainTrustReason =
	| 'no_source'
	| 'source_not_whitelisted'
	| 'address_mismatch'
	| 'record_key_id_missing'
	| 'key_id_mismatch'
	| 'bad_fingerprint'

export type ChainTrustVerdict = { trusted: true } | { trusted: false; reason: ChainTrustReason }

const HEX = /^[0-9a-f]+$/

const normHex = (value: unknown): string => String(value ?? '').trim().toLowerCase().replace(/^0x/, '')

const sameAddress = (a: unknown, b: unknown): boolean => {
	const x = String(a ?? '').trim().toLowerCase()
	const y = String(b ?? '').trim().toLowerCase()
	return /^0x[0-9a-f]{40}$/.test(x) && x === y
}

/**
 * True when the chain record's key id matches the fingerprint of the key in use. The record carries a key id (16 hex: the low 64 bits of a v4 fingerprint,
 * the high 64 bits of a v6 one) or the full fingerprint. Case and a 0x prefix are ignored; anything else does not match.
 */
export function keyIdMatchesFingerprint(recordKeyId: unknown, fingerprint: unknown): boolean {
	const id = normHex(recordKeyId)
	const fp = normHex(fingerprint)
	if (!HEX.test(id) || !HEX.test(fp)) return false
	if (fp.length === 40) return id === fp || (id.length === 16 && fp.endsWith(id))
	if (fp.length === 64) return id === fp || (id.length === 16 && fp.startsWith(id))
	return false
}

/**
 * The three conditions. `contactAddress`: the contact the send is for. `source`: where the record was read from. `userPgpKeyID`: the key id the chain record
 * carries (the encryption subkey's). `encryptionFingerprint`: the fingerprint of the key that will encrypt (computed from the very armor that is used).
 */
export function chainRecordTrust(input: {
	contactAddress: string | undefined
	source: RecordSource | undefined
	userPgpKeyID: string | undefined
	/** The OpenPGP fingerprint of the primary key (what is pinned and shown). It must be well formed; it is not what the record's id names. */
	fingerprint: string | undefined
	/** The OpenPGP fingerprint of the key that encrypts (the encryption subkey, or the primary key when there is none): the record's id is its key ID. */
	encryptionFingerprint: string | undefined
}): ChainTrustVerdict {
	const { source } = input
	if (!source) return { trusted: false, reason: 'no_source' }
	const listed = CHAIN_PGP_WHITELIST.some(
		(w) => w.chainId === source.chainId && w.contract.toLowerCase() === String(source.contract ?? '').trim().toLowerCase(),
	)
	if (!listed) return { trusted: false, reason: 'source_not_whitelisted' }
	if (!sameAddress(source.queriedAddress, input.contactAddress)) return { trusted: false, reason: 'address_mismatch' }
	if (!normHex(input.userPgpKeyID)) return { trusted: false, reason: 'record_key_id_missing' }
	const wellFormed = (fp: string | undefined): boolean => !!fp && /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(normHex(fp))
	if (!wellFormed(input.fingerprint) || !wellFormed(input.encryptionFingerprint)) return { trusted: false, reason: 'bad_fingerprint' }
	if (!keyIdMatchesFingerprint(input.userPgpKeyID, input.encryptionFingerprint)) return { trusted: false, reason: 'key_id_mismatch' }
	return { trusted: true }
}

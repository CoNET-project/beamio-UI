/**
 * @jest-environment node
 */
/**
 * First-contact trust of a key that comes from the chain. One rule for the send gate, the receipt route and (by vectors)
 * any native implementation: services/vectors/firstContactChainTrust.v2.json. SYNTHETIC addresses and keys generated here.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { generateKey, readKey } from 'openpgp'
import { CHAIN_PGP_WHITELIST, chainRecordTrust, keyIdMatchesFingerprint } from './chainPgpTrust'
import { decideTrustedRoute, fingerprintOfArmor, resolveTrustedRoute, sendWithFreshRoute, type RecipientLookup } from './recipientPublicKey'
import { storedKeyFingerprint } from './pgpFingerprint'

const WL = '0x684b0ac760cEE9c9b85de36d69746420648Cf9e2'
const CONTACT = '0x' + 'ab12'.repeat(10)
const OTHER = '0x' + '33'.repeat(20)

type Vector = {
	id: string
	description: string
	contactAddress: string
	storedVerifiedFingerprint: string | null
	read: { kind: 'ok' | 'fail'; code?: string; fingerprint?: string; encryptionFingerprint?: string; userPgpKeyID?: string; source?: { chainId: number; contract: string; queriedAddress: string } | null }
	expect: { decision: string; firstPin: boolean }
}
const vectors = JSON.parse(readFileSync(join(__dirname, '..', 'services', 'vectors', 'firstContactChainTrust.v2.json'), 'utf8')) as { whitelist: Array<{ chainId: number; contract: string }>; cases: Vector[] }

describe('whitelist', () => {
	it('is hard-coded: exactly the AddressPGP contract on chain 224422, and the vector file states the same', () => {
		expect(CHAIN_PGP_WHITELIST).toEqual([{ chainId: 224422, contract: WL }])
		expect(vectors.whitelist).toEqual([{ chainId: 224422, contract: WL }])
	})
})

describe('the shared vectors (decideTrustedRoute)', () => {
	for (const v of vectors.cases) {
		it(`${v.id}: ${v.description}`, () => {
			const chat = {
				address: v.contactAddress,
				chatData: v.storedVerifiedFingerprint ? { verifiedFingerprint: storedKeyFingerprint(v.storedVerifiedFingerprint) } : {},
			}
			const fresh =
				v.read.kind === 'ok'
					? ({
							ok: true,
							changed: false,
							publicArmored: 'ARMOR',
							routersArmoreds: 'ROUTE',
							fingerprint: v.read.fingerprint ?? '',
							encryptionFingerprint: v.read.encryptionFingerprint,
							fingerprintChanged: false,
							userPgpKeyID: v.read.userPgpKeyID,
							source: v.read.source ?? undefined,
						} as const)
					: ({ ok: false, code: v.read.code } as never)
			const d = decideTrustedRoute(chat, fresh as never)
			const got = d.ok ? 'send_direct' : d.code
			expect(got).toBe(v.expect.decision)
			expect(d.ok && d.firstPin === true).toBe(v.expect.firstPin)
		})
	}
})

describe('keyIdMatchesFingerprint', () => {
	it('v4 tail, v6 head, full value, case and 0x; nothing else', () => {
		const fp = '0123456789abcdef0123456789abcdef01234567'
		expect(keyIdMatchesFingerprint(fp.slice(-16), fp)).toBe(true)
		expect(keyIdMatchesFingerprint('0X' + fp.slice(-16).toUpperCase(), fp)).toBe(true)
		expect(keyIdMatchesFingerprint(fp, fp)).toBe(true)
		expect(keyIdMatchesFingerprint(fp.slice(0, 16), fp)).toBe(false)
		expect(keyIdMatchesFingerprint('', fp)).toBe(false)
		expect(keyIdMatchesFingerprint(fp.slice(-16), 'abc')).toBe(false)
		// an asymmetric v6 sample, so that the direction (head for v6, tail for v4) and the 16-hex length rule are both pinned by a test
		const fp6 = '0123456789abcdef' + 'a1b2c3d4e5f60718' + '1829384756a7b6c5' + 'fedcba9876543210'
		expect(keyIdMatchesFingerprint(fp6.slice(0, 16), fp6)).toBe(true)
		expect(keyIdMatchesFingerprint(fp6.slice(-16), fp6)).toBe(false)
		expect(keyIdMatchesFingerprint(fp.slice(-8), fp)).toBe(false)
		expect(keyIdMatchesFingerprint(fp.slice(-17), fp)).toBe(false)
		expect(keyIdMatchesFingerprint(fp6.slice(0, 8), fp6)).toBe(false)
	})
})

// ---- through the real send path with real keys -------------------------------------------------------------------------------------------------
let KEY_A = ''
let KEY_B = ''
let FP_A = ''
let FP_B = ''
let ID_A = ''
let ID_B = ''
let PRIMARY_ID_A = ''
beforeAll(async () => {
	const a = await generateKey({ type: 'curve25519', userIDs: [{ name: 'a' }], format: 'armored' })
	const b = await generateKey({ type: 'curve25519', userIDs: [{ name: 'b' }], format: 'armored' })
	KEY_A = a.publicKey.trim()
	KEY_B = b.publicKey.trim()
	FP_A = await fingerprintOfArmor(KEY_A)
	FP_B = await fingerprintOfArmor(KEY_B)
	// the AddressPGP record carries the ENCRYPTION SUBKEY's key id (measured on the chain), never the primary key's
	ID_A = (await (await readKey({ armoredKey: KEY_A })).getEncryptionKey()).getKeyID().toHex().toUpperCase()
	ID_B = (await (await readKey({ armoredKey: KEY_B })).getEncryptionKey()).getKeyID().toHex().toUpperCase()
	PRIMARY_ID_A = (await readKey({ armoredKey: KEY_A })).getKeyID().toHex().toUpperCase()
}, 60_000)

const okRead = (over: Partial<Extract<RecipientLookup, { status: 'ok' }>> = {}) =>
	jest.fn(async (): Promise<RecipientLookup> => ({
		status: 'ok',
		publicArmored: KEY_A,
		routersArmoreds: 'route-1',
		routePgpKeyID: 'route-key-1',
		userPgpKeyID: ID_A,
		source: { chainId: 224422, contract: WL, queriedAddress: CONTACT },
		...over,
	}))
const chat = (verified?: string) => ({ address: CONTACT, chatData: { verifiedFingerprint: verified ? storedKeyFingerprint(verified) : undefined } })

describe('first contact through sendWithFreshRoute (real keys)', () => {
	it('all three conditions met: sent directly, no hold, and the fingerprint is recorded as the first pinned value', async () => {
		const send = jest.fn(async () => true)
		const onFirstPinned = jest.fn()
		const r = await sendWithFreshRoute(chat(), 'hi', 'pk', ['n'], { fetchKeys: okRead(), send, onFirstPinned })
		expect(r).toEqual({ ok: true, viaUnconfirmedRoute: false })
		expect(send).toHaveBeenCalledWith(KEY_A, 'hi', 'pk', ['n'])
		expect(onFirstPinned).toHaveBeenCalledTimes(1)
		expect(onFirstPinned).toHaveBeenCalledWith({ publicArmored: KEY_A, routersArmoreds: 'route-1', routePgpKeyID: 'route-key-1', fingerprint: FP_A })
	})

	it('the pin is recorded only after a delivered send (a failed send records nothing)', async () => {
		const onFirstPinned = jest.fn()
		const r = await sendWithFreshRoute(chat(), 'hi', 'pk', ['n'], { fetchKeys: okRead(), send: jest.fn(async () => false), onFirstPinned })
		expect(r).toEqual({ ok: false, code: 'send_failed' })
		expect(onFirstPinned).not.toHaveBeenCalled()
	})

	it('a throwing pin callback never changes a delivered send', async () => {
		const r = await sendWithFreshRoute(chat(), 'hi', 'pk', ['n'], { fetchKeys: okRead(), send: jest.fn(async () => true), onFirstPinned: () => { throw new Error('x') } })
		expect(r.ok).toBe(true)
	})

	const held = async (read: ReturnType<typeof okRead>) => {
		const send = jest.fn(async () => true)
		const onFirstPinned = jest.fn()
		const r = await sendWithFreshRoute(chat(), 'hi', 'pk', ['n'], { fetchKeys: read, send, onFirstPinned })
		expect(send).not.toHaveBeenCalled()
		expect(onFirstPinned).not.toHaveBeenCalled()
		return r
	}

	it('condition 1 fails (source not whitelisted: another contract): held first_fetch_pending with the key that was read', async () => {
		const r = await held(okRead({ source: { chainId: 224422, contract: '0x' + '44'.repeat(20), queriedAddress: CONTACT } }))
		expect(r).toMatchObject({ ok: false, code: 'first_fetch_pending', held: { publicArmored: KEY_A, fingerprint: FP_A } })
	})
	it('condition 1 fails (no source reported): held', async () => {
		expect(await held(okRead({ source: undefined }))).toMatchObject({ ok: false, code: 'first_fetch_pending' })
	})
	it('condition 1 fails (right contract, another chain): held', async () => {
		expect(await held(okRead({ source: { chainId: 8453, contract: WL, queriedAddress: CONTACT } }))).toMatchObject({ code: 'first_fetch_pending' })
	})
	it('condition 2 fails (the record was read for another address): held', async () => {
		expect(await held(okRead({ source: { chainId: 224422, contract: WL, queriedAddress: OTHER } }))).toMatchObject({ code: 'first_fetch_pending' })
	})
	it('condition 3 fails (the key in use is not the key the chain record names): held', async () => {
		expect(await held(okRead({ publicArmored: KEY_B, userPgpKeyID: ID_A }))).toMatchObject({ code: 'first_fetch_pending', held: { fingerprint: FP_B } })
	})
	it('REGRESSION 0.53.55: a record that carries the PRIMARY key id (not the encryption subkey id) is held; the real record shape (subkey id) is sent', async () => {
		expect(ID_A).not.toBe(PRIMARY_ID_A)
		expect(await held(okRead({ userPgpKeyID: PRIMARY_ID_A }))).toMatchObject({ code: 'first_fetch_pending' })
	})
	it('condition 3 fails (the record carries no key id): held', async () => {
		expect(await held(okRead({ userPgpKeyID: '' }))).toMatchObject({ code: 'first_fetch_pending' })
	})

	it('read failure: route_unconfirmed, never trusted, nothing sent', async () => {
		const failing = jest.fn(async (): Promise<RecipientLookup> => ({ status: 'network_error', reason: 'timeout' }))
		expect(await held(failing as never)).toMatchObject({ ok: false, code: 'route_unconfirmed' })
		const throwing = jest.fn(async () => { throw new Error('rpc down') })
		expect(await held(throwing as never)).toMatchObject({ ok: false, code: 'route_unconfirmed' })
	})

	it('an internal fault is not trusted either', async () => {
		const bad = jest.fn(async (): Promise<RecipientLookup> => ({ status: 'internal_error', reason: 'abi_missing' }))
		const r = await held(bad as never)
		expect(r.ok).toBe(false)
	})

	it('fingerprint changed after the first pin: fingerprint_changed, held with the new key, even though the new record is chain-trusted', async () => {
		const send = jest.fn(async () => true)
		const read = okRead({ publicArmored: KEY_B, userPgpKeyID: ID_B })
		const r = await sendWithFreshRoute(chat(FP_A), 'hi', 'pk', ['n'], { fetchKeys: read, send })
		expect(r).toMatchObject({ ok: false, code: 'fingerprint_changed', held: { fingerprint: FP_B } })
		expect(send).not.toHaveBeenCalled()
	})

	it('already pinned and the same key: sent, and no new pin is recorded', async () => {
		const onFirstPinned = jest.fn()
		const r = await sendWithFreshRoute(chat(FP_A), 'hi', 'pk', ['n'], { fetchKeys: okRead(), send: jest.fn(async () => true), onFirstPinned })
		expect(r.ok).toBe(true)
		expect(onFirstPinned).not.toHaveBeenCalled()
	})
})

describe('chainRecordTrust reasons', () => {
	const base = { contactAddress: CONTACT, source: { chainId: 224422, contract: WL, queriedAddress: CONTACT }, userPgpKeyID: 'abcdef0123456789', fingerprint: '1'.repeat(40), encryptionFingerprint: '0'.repeat(24) + 'abcdef0123456789' }
	it('names the first failing condition', () => {
		expect(chainRecordTrust(base)).toEqual({ trusted: true })
		expect(chainRecordTrust({ ...base, source: undefined })).toEqual({ trusted: false, reason: 'no_source' })
		expect(chainRecordTrust({ ...base, source: { ...base.source, contract: OTHER } })).toEqual({ trusted: false, reason: 'source_not_whitelisted' })
		expect(chainRecordTrust({ ...base, source: { ...base.source, queriedAddress: OTHER } })).toEqual({ trusted: false, reason: 'address_mismatch' })
		expect(chainRecordTrust({ ...base, contactAddress: 'not an address' })).toEqual({ trusted: false, reason: 'address_mismatch' })
		expect(chainRecordTrust({ ...base, userPgpKeyID: undefined })).toEqual({ trusted: false, reason: 'record_key_id_missing' })
		expect(chainRecordTrust({ ...base, userPgpKeyID: '1111111111111111' })).toEqual({ trusted: false, reason: 'key_id_mismatch' })
		expect(chainRecordTrust({ ...base, fingerprint: undefined })).toEqual({ trusted: false, reason: 'bad_fingerprint' })
		expect(chainRecordTrust({ ...base, encryptionFingerprint: undefined })).toEqual({ trusted: false, reason: 'bad_fingerprint' })
		// the primary fingerprint is not what the record's id names
		expect(chainRecordTrust({ ...base, userPgpKeyID: '1'.repeat(16) })).toEqual({ trusted: false, reason: 'key_id_mismatch' })
	})
})

describe('the same decision for the receipt route (resolveTrustedRoute is what receiptRouteTrust reads)', () => {
	it('an unverified chain-trusted contact is ok with firstPin; a non-whitelisted source is held', async () => {
		const a = await resolveTrustedRoute(chat(), okRead())
		expect(a).toMatchObject({ ok: true, firstPin: true, fingerprint: FP_A })
		const b = await resolveTrustedRoute(chat(), okRead({ source: undefined }))
		expect(b).toMatchObject({ ok: false, code: 'first_fetch_pending' })
	})
})

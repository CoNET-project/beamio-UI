/**
 * @jest-environment node
 */
/**
 * a contact's key is trusted only after the user has verified its OpenPGP fingerprint (no trust on first use).
 * First contact is held as first_fetch_pending and a key other than the verified one as fingerprint_changed; both holds carry the key that was
 * read. The user's verification or acceptance sends and writes exactly the key on screen, without a new fetch. SYNTHETIC keys generated here.
 */
import { generateKey } from 'openpgp'
import { fingerprintOfArmor, resolveRecipientForSend, resolveTrustedRoute, sendViaCachedRoute, sendWithFreshRoute, sendWithPinnedRoute } from './recipientPublicKey'
import { storedKeyFingerprint } from './pgpFingerprint'

const ADDRESS = '0x2222222222222222222222222222222222222222'
let KEY_A = ''
let KEY_B = ''
let FP_A = ''
let FP_B = ''

beforeAll(async () => {
	KEY_A = (await generateKey({ type: 'curve25519', userIDs: [{ name: 'a' }], format: 'armored' })).publicKey.trim()
	KEY_B = (await generateKey({ type: 'curve25519', userIDs: [{ name: 'b' }], format: 'armored' })).publicKey.trim()
	FP_A = await fingerprintOfArmor(KEY_A)
	FP_B = await fingerprintOfArmor(KEY_B)
}, 60_000)

const fetchOf = (key: string) =>
	jest.fn(async () => ({ status: 'ok' as const, publicArmored: key, routersArmoreds: 'route-1', routePgpKeyID: 'route-key-1' }))
/** The chat copy as the app stores it: the fingerprints carry the OpenPGP scheme . */
const chat = (publicArmored: string, keyFingerprint?: string, verifiedFingerprint?: string) => ({
	address: ADDRESS,
	chatData: {
		publicArmored,
		routersArmoreds: 'route-1',
		keyFingerprint: keyFingerprint ? storedKeyFingerprint(keyFingerprint) : undefined,
		verifiedFingerprint: verifiedFingerprint ? storedKeyFingerprint(verifiedFingerprint) : undefined,
	},
})

describe('first contact is held until the user verifies the key', () => {
	it('first contact (no verified key): held as first_fetch_pending with the key and its fingerprint, and nothing is sent', async () => {
		const send = jest.fn(async () => true)
		const r = await sendWithFreshRoute(chat(KEY_A), 'hi', 'pk', ['n'], { fetchKeys: fetchOf(KEY_A), send })
		expect(r).toMatchObject({ ok: false, code: 'first_fetch_pending', held: { publicArmored: KEY_A, routersArmoreds: 'route-1', fingerprint: FP_A } })
		expect(send).not.toHaveBeenCalled()
	})

	it('the user verifies the key on screen: that key is sent, reported as accepted, and no new fetch is made', async () => {
		const fetchKeys = fetchOf(KEY_B)
		const send = jest.fn(async () => true)
		const onAccepted = jest.fn()
		const held = { publicArmored: KEY_A, routersArmoreds: 'route-1', fingerprint: FP_A }
		const r = await sendWithPinnedRoute('hi', 'pk', ['n'], { pinned: held, send, onAccepted })
		expect(r).toEqual({ ok: true, viaUnconfirmedRoute: false })
		expect(send).toHaveBeenCalledWith(KEY_A, 'hi', 'pk', ['n'])
		expect(onAccepted).toHaveBeenCalledWith(held)
		expect(fetchKeys).not.toHaveBeenCalled()
	})

	it('a network error is still route_unconfirmed, not first_fetch_pending', async () => {
		const send = jest.fn(async () => true)
		const r = await sendWithFreshRoute(chat(KEY_A), 'hi', 'pk', ['n'], {
			fetchKeys: async () => ({ status: 'network_error' as const, reason: 'rpc' }),
			send,
		})
		expect(r).toEqual({ ok: false, code: 'route_unconfirmed' })
		expect(send).not.toHaveBeenCalled()
	})

	it('the first-contact hold refuses the send from the other screens too (resolveRecipientForSend)', async () => {
		const r = await resolveRecipientForSend(chat(KEY_A), fetchOf(KEY_A))
		expect(r).toEqual({ ok: false, code: 'first_fetch_pending' })
	})
})

describe('a verified contact', () => {
	it('whose key is the verified one sends without a hold', async () => {
		const send = jest.fn(async () => true)
		const r = await sendWithFreshRoute(chat(KEY_A, FP_A, FP_A), 'hi', 'pk', ['n'], { fetchKeys: fetchOf(KEY_A), send })
		expect(r).toEqual({ ok: true, viaUnconfirmedRoute: false })
	})

	it('whose key changed is held as fingerprint_changed with the new key, and nothing is sent without the user', async () => {
		const send = jest.fn(async () => true)
		const r = await sendWithFreshRoute(chat(KEY_A, FP_A, FP_A), 'hi', 'pk', ['n'], { fetchKeys: fetchOf(KEY_B), send })
		expect(r).toMatchObject({ ok: false, code: 'fingerprint_changed', held: { publicArmored: KEY_B, fingerprint: FP_B } })
		expect(send).not.toHaveBeenCalled()
	})

	it('whose changed key the user accepts: the key on screen is sent and written as verified, with no fetch at that moment', async () => {
		const fetchKeys = fetchOf(KEY_B)
		const send = jest.fn(async () => true)
		const onAccepted = jest.fn()
		const held = { publicArmored: KEY_B, routersArmoreds: 'route-1', fingerprint: FP_B }
		const r = await sendWithPinnedRoute('hi', 'pk', ['n'], { pinned: held, send, onAccepted })
		expect(r).toEqual({ ok: true, viaUnconfirmedRoute: false })
		expect(onAccepted).toHaveBeenCalledWith(expect.objectContaining({ fingerprint: FP_B }))
		expect(fetchKeys).not.toHaveBeenCalled()
	})

	it('the trust decision reports the verified contact and the fetched key', async () => {
		const ok = await resolveTrustedRoute(chat(KEY_A, FP_A, FP_A), fetchOf(KEY_A))
		expect(ok).toMatchObject({ ok: true, fingerprint: FP_A })
		const changed = await resolveTrustedRoute(chat(KEY_A, FP_A, FP_A), fetchOf(KEY_B))
		expect(changed).toMatchObject({ ok: false, code: 'fingerprint_changed', held: { fingerprint: FP_B } })
	})
})

describe('"send anyway" uses the cached key under the same trust rule', () => {
	it('first contact is held as first_fetch_pending with the cached key; the cached key is not sent', async () => {
		const send = jest.fn(async () => true)
		const r = await sendViaCachedRoute(chat(KEY_A), 'hi', 'pk', ['n'], { send })
		expect(r).toMatchObject({ ok: false, code: 'first_fetch_pending', held: { publicArmored: KEY_A, fingerprint: FP_A } })
		expect(send).not.toHaveBeenCalled()
	})

	it('a verified contact sends via the unconfirmed route', async () => {
		const send = jest.fn(async () => true)
		const r = await sendViaCachedRoute(chat(KEY_A, FP_A, FP_A), 'hi', 'pk', ['n'], { send })
		expect(r).toEqual({ ok: true, viaUnconfirmedRoute: true })
	})

	it('a cached key that is not the verified one is held as fingerprint_changed', async () => {
		const send = jest.fn(async () => true)
		const r = await sendViaCachedRoute(chat(KEY_B, FP_B, FP_A), 'hi', 'pk', ['n'], { send })
		expect(r).toMatchObject({ ok: false, code: 'fingerprint_changed', held: { fingerprint: FP_B } })
		expect(send).not.toHaveBeenCalled()
	})
})

describe('the verified fingerprint carries its scheme; an unlabelled value is not a verification', () => {
	it('an unlabelled verified value (an earlier build) does not release the send: first contact again', async () => {
		const send = jest.fn(async () => true)
		const legacy = { address: ADDRESS, chatData: { publicArmored: KEY_A, routersArmoreds: 'route-1', verifiedFingerprint: FP_A } }
		const r = await sendWithFreshRoute(legacy, 'hi', 'pk', ['n'], { fetchKeys: fetchOf(KEY_A), send })
		expect(r).toMatchObject({ ok: false, code: 'first_fetch_pending' })
		expect(send).not.toHaveBeenCalled()
	})

	it('a verified contact whose key changed is held as fingerprint_changed even without a fetched baseline', async () => {
		const r = await resolveTrustedRoute({ address: ADDRESS, chatData: { publicArmored: KEY_A, routersArmoreds: 'route-1', verifiedFingerprint: storedKeyFingerprint(FP_A) } }, fetchOf(KEY_B))
		expect(r).toMatchObject({ ok: false, code: 'fingerprint_changed', held: { fingerprint: FP_B } })
	})
})

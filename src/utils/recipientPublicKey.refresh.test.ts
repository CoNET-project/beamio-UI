/**
 * @jest-environment node
 */
/**
 * every send fetches the recipient's current key and route first. A network error holds the
 * send; no record is reported as such and is not held; a key that is not the verified one is held with the key that was read; "send anyway"
 * uses the cached route and is marked. The fingerprint is the OpenPGP fingerprint of a real key (generated in the test). SYNTHETIC values only.
 */
import { generateKey } from 'openpgp'
import { RECIPIENT_REFRESH_PERIOD_MS, RECIPIENT_ROUTE_RETRY_DELAYS_MS, fingerprintOfArmor, refreshRecipient, sendViaCachedRoute, sendWithFreshRoute } from './recipientPublicKey'
import { storedKeyFingerprint } from './pgpFingerprint'

const ADDRESS = '0x2222222222222222222222222222222222222222'
let KEY_OLD = ''
let KEY_NEW = ''
let FP_OLD = ''
let FP_NEW = ''

beforeAll(async () => {
	KEY_OLD = (await generateKey({ type: 'curve25519', userIDs: [{ name: 'old' }], format: 'armored' })).publicKey.trim()
	KEY_NEW = (await generateKey({ type: 'curve25519', userIDs: [{ name: 'new' }], format: 'armored' })).publicKey.trim()
	FP_OLD = await fingerprintOfArmor(KEY_OLD)
	FP_NEW = await fingerprintOfArmor(KEY_NEW)
}, 60_000)

/** A simulated recipient: its current key and route, and the sender's cached route (the lookup updates the cache, as chat.ts does). */
function world(init: { key: string; route: string; cachedRoute: string }) {
	const w = { ...init }
	const fetchRoute = jest.fn(async () => {
		w.cachedRoute = w.route
		return { status: 'ok' as const, publicArmored: w.key, routersArmoreds: w.route }
	})
	/** The send reaches the recipient only with the current key and the cached (current) route. */
	const send = jest.fn(async (pgp: string) => pgp === w.key && w.cachedRoute === w.route)
	return { w, fetchRoute, send }
}
/** The chat copy as the app stores it: the fingerprints carry the OpenPGP scheme . */
const chatWith = (publicArmored: string, routersArmoreds: string, keyFingerprint?: string, verifiedFingerprint?: string) => ({
	address: ADDRESS,
	chatData: {
		publicArmored,
		routersArmoreds,
		keyFingerprint: keyFingerprint ? storedKeyFingerprint(keyFingerprint) : undefined,
		verifiedFingerprint: verifiedFingerprint ? storedKeyFingerprint(verifiedFingerprint) : undefined,
	},
})

describe('the period and the held-send retries', () => {
	it('the period is 5 minutes and the held-send retries are 30 s, 2 min, 10 min', () => {
		expect(RECIPIENT_REFRESH_PERIOD_MS).toBe(5 * 60 * 1000)
		expect(RECIPIENT_ROUTE_RETRY_DELAYS_MS).toEqual([30_000, 120_000, 600_000])
	})
})

describe('sendWithFreshRoute: the route is fetched before every send', () => {
	it('a send fetches first even when the chat copy has a verified key; the fresh route is used', async () => {
		const { fetchRoute, send } = world({ key: KEY_OLD, route: 'route-new', cachedRoute: 'route-new' })
		const r = await sendWithFreshRoute(chatWith(KEY_OLD, 'route-old', FP_OLD, FP_OLD), 'hi', 'pk', ['n'], { fetchKeys: fetchRoute, send })
		expect(r).toEqual({ ok: true, viaUnconfirmedRoute: false })
		expect(fetchRoute).toHaveBeenCalledTimes(1)
		expect(send).toHaveBeenCalledTimes(1)
	})

	it('the recipient changes its mailbox: the send goes to the new route after the fetch', async () => {
		const { fetchRoute, send } = world({ key: KEY_OLD, route: 'route-new', cachedRoute: 'route-old' })
		const r = await sendWithFreshRoute(chatWith(KEY_OLD, 'route-old', undefined, FP_OLD), 'hi', 'pk', ['n'], { fetchKeys: fetchRoute, send })
		expect(r).toEqual({ ok: true, viaUnconfirmedRoute: false })
		expect(send).toHaveBeenCalledTimes(1)
	})

	it('the recipient changes its key: held as fingerprint_changed with the key that was read, and nothing is sent', async () => {
		const { fetchRoute, send } = world({ key: KEY_NEW, route: 'route-a', cachedRoute: 'route-a' })
		const r = await sendWithFreshRoute(chatWith(KEY_OLD, 'route-a', FP_OLD, FP_OLD), 'hi', 'pk', ['n'], { fetchKeys: fetchRoute, send })
		expect(r).toMatchObject({ ok: false, code: 'fingerprint_changed', held: { publicArmored: KEY_NEW, routersArmoreds: 'route-a', fingerprint: FP_NEW } })
		expect(send).not.toHaveBeenCalled()
	})

	it('a network error holds the send as route_unconfirmed; nothing is sent on the old route', async () => {
		const send = jest.fn(async () => true)
		const r = await sendWithFreshRoute(chatWith(KEY_OLD, 'route-old'), 'hi', 'pk', ['n'], { fetchKeys: async () => ({ status: 'network_error', reason: 'rpc' }), send })
		expect(r).toEqual({ ok: false, code: 'route_unconfirmed' })
		expect(send).not.toHaveBeenCalled()
	})

	it('an incomplete registration (a key without a route) is a network error, held, not no_record', async () => {
		const send = jest.fn(async () => true)
		const r = await sendWithFreshRoute(chatWith(KEY_OLD, 'route-old'), 'hi', 'pk', ['n'], { fetchKeys: async () => ({ status: 'ok' as const, publicArmored: KEY_OLD, routersArmoreds: '' }), send })
		expect(r).toEqual({ ok: false, code: 'route_unconfirmed' })
		expect(send).not.toHaveBeenCalled()
	})

	it('a valid empty answer is recipient_no_record: reported, not held, not sent', async () => {
		const send = jest.fn(async () => true)
		const r = await sendWithFreshRoute(chatWith(KEY_OLD, 'route-old'), 'hi', 'pk', ['n'], { fetchKeys: async () => ({ status: 'no_record' as const }), send })
		expect(r).toEqual({ ok: false, code: 'recipient_no_record' })
		expect(send).not.toHaveBeenCalled()
	})
})

describe('sendViaCachedRoute: "send anyway" is the user\'s choice and is marked', () => {
	it('uses the verified cached key and route only, makes no fetch, and is marked as sent via an unconfirmed route', async () => {
		const send = jest.fn(async () => true)
		const r = await sendViaCachedRoute(chatWith(KEY_OLD, 'route-old', FP_OLD, FP_OLD), 'hi', 'pk', ['n'], { send })
		expect(r).toEqual({ ok: true, viaUnconfirmedRoute: true })
		expect(send).toHaveBeenCalledWith(KEY_OLD, 'hi', 'pk', ['n'])
	})

	it('without a cached key it is an error, not a silent send', async () => {
		const send = jest.fn(async () => true)
		const r = await sendViaCachedRoute({ address: ADDRESS, chatData: {} }, 'hi', 'pk', ['n'], { send })
		expect(r).toEqual({ ok: false, code: 'recipient_key_unavailable' })
		expect(send).not.toHaveBeenCalled()
	})
})

describe('refreshRecipient: the three results and the OpenPGP fingerprint (-2, -4)', () => {
	it('reports a route change, and no change when both values are the same', async () => {
		const same = await refreshRecipient(chatWith(KEY_OLD, 'r'), async () => ({ status: 'ok' as const, publicArmored: KEY_OLD, routersArmoreds: 'r' }))
		expect(same).toMatchObject({ ok: true, changed: false, fingerprintChanged: false })
		const moved = await refreshRecipient(chatWith(KEY_OLD, 'r'), async () => ({ status: 'ok' as const, publicArmored: KEY_OLD, routersArmoreds: 'r2' }))
		expect(moved).toMatchObject({ ok: true, changed: true, routersArmoreds: 'r2' })
	})

	it('the fingerprint is the OpenPGP fingerprint of the key (lowercase hex), not a hash of the armor text', async () => {
		const r = await refreshRecipient(chatWith(KEY_OLD, 'r'), async () => ({ status: 'ok' as const, publicArmored: KEY_OLD, routersArmoreds: 'r' }))
		expect(r).toMatchObject({ ok: true, fingerprint: FP_OLD })
		expect(FP_OLD).toMatch(/^[0-9a-f]{40}$/)
	})

	it('the same key with cosmetically different armor (a trailing line break) has the same fingerprint', async () => {
		const reArmored = `${KEY_OLD}\n\n`
		expect(await fingerprintOfArmor(reArmored)).toBe(FP_OLD)
	})

	it('a fingerprint that differs from the stored one is a fingerprint change; a first fetch (none stored) is not', async () => {
		const changed = await refreshRecipient(chatWith(KEY_OLD, 'r', FP_OLD), async () => ({ status: 'ok' as const, publicArmored: KEY_NEW, routersArmoreds: 'r' }))
		expect(changed).toMatchObject({ ok: true, fingerprintChanged: true })
		const first = await refreshRecipient(chatWith(KEY_OLD, 'r'), async () => ({ status: 'ok' as const, publicArmored: KEY_OLD, routersArmoreds: 'r' }))
		expect(first).toMatchObject({ ok: true, fingerprintChanged: false, fingerprint: FP_OLD })
	})

	it('no_record, network_error and an invalid key keep their own codes', async () => {
		const chat = chatWith(KEY_OLD, 'r')
		expect(await refreshRecipient(chat, async () => ({ status: 'no_record' as const }))).toEqual({ ok: false, code: 'recipient_no_record' })
		expect(await refreshRecipient(chat, async () => ({ status: 'network_error' as const, reason: 'rpc' }))).toEqual({ ok: false, code: 'network_error' })
		expect(await refreshRecipient(chat, async () => ({ status: 'ok' as const, publicArmored: 'garbage', routersArmoreds: 'r' }))).toEqual({ ok: false, code: 'recipient_key_invalid' })
		expect(await refreshRecipient(chat, async () => {
			throw new Error('rpc')
		})).toEqual({ ok: false, code: 'network_error' })
	})
})

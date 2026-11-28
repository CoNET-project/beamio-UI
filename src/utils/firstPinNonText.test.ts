/**
 * @jest-environment node
 */
// the first pinned fingerprint is also recorded by the non-text paths (payment, group, gift, receipt, call). SYNTHETIC values.
import { recordFirstPinFor, resolveRecipientForSend, setFirstPinRecorder, type RecipientLookup } from './recipientPublicKey'
import { generateKey } from 'openpgp'
import { fingerprintOfArmor } from './recipientPublicKey'
import { storedKeyFingerprint } from './pgpFingerprint'

const WL = '0x684b0ac760cEE9c9b85de36d69746420648Cf9e2'
const CONTACT = '0x' + 'ab12'.repeat(10)
let KEY = ''
let FP = ''
let KID = ''
beforeAll(async () => {
	const k = await generateKey({ type: 'curve25519', userIDs: [{ name: 'a' }], format: 'armored' })
	KEY = k.publicKey.trim()
	FP = await fingerprintOfArmor(KEY)
	// the record carries the ENCRYPTION SUBKEY's key id (measured on the chain)
	KID = (await (await (await import('openpgp')).readKey({ armoredKey: KEY })).getEncryptionKey()).getKeyID().toHex()
}, 60_000)

const read = (over: Partial<Extract<RecipientLookup, { status: 'ok' }>> = {}) =>
	jest.fn(async (): Promise<RecipientLookup> => ({ status: 'ok', publicArmored: KEY, routersArmoreds: 'route-1', routePgpKeyID: 'r1', userPgpKeyID: KID, source: { chainId: 224422, contract: WL, queriedAddress: CONTACT }, ...over }))
const chat = (verified?: string) => ({ address: CONTACT, chatData: { verifiedFingerprint: verified ? storedKeyFingerprint(verified) : undefined } })

describe('non-text paths record the first pinned value', () => {
	afterEach(() => setFirstPinRecorder(null))

	it('resolveRecipientForSend: a chain-trusted first contact is allowed and its fingerprint is recorded once', async () => {
		const rec = jest.fn()
		setFirstPinRecorder(rec)
		const r = await resolveRecipientForSend(chat(), read())
		expect(r).toEqual({ ok: true, publicArmored: KEY, routersArmoreds: 'route-1' })
		expect(rec).toHaveBeenCalledTimes(1)
		expect(rec).toHaveBeenCalledWith(CONTACT, { publicArmored: KEY, routersArmoreds: 'route-1', routePgpKeyID: 'r1', fingerprint: FP })
	})
	it('already pinned and the same key: allowed, nothing recorded', async () => {
		const rec = jest.fn()
		setFirstPinRecorder(rec)
		expect((await resolveRecipientForSend(chat(FP), read())).ok).toBe(true)
		expect(rec).not.toHaveBeenCalled()
	})
	it('a hold (source not whitelisted, read failure, changed fingerprint) records nothing', async () => {
		const rec = jest.fn()
		setFirstPinRecorder(rec)
		expect(await resolveRecipientForSend(chat(), read({ source: undefined }))).toEqual({ ok: false, code: 'first_fetch_pending' })
		expect(await resolveRecipientForSend(chat(), jest.fn(async () => ({ status: 'network_error', reason: 'x' }) as RecipientLookup))).toEqual({ ok: false, code: 'route_unconfirmed' })
		expect(await resolveRecipientForSend(chat('f'.repeat(40)), read())).toEqual({ ok: false, code: 'fingerprint_changed' })
		expect(rec).not.toHaveBeenCalled()
	})
	it('a throwing recorder never changes the decision', async () => {
		setFirstPinRecorder(() => {
			throw new Error('store down')
		})
		expect((await resolveRecipientForSend(chat(), read())).ok).toBe(true)
	})
	it('recordFirstPinFor needs firstPin, an address and a recorder', () => {
		const rec = jest.fn()
		setFirstPinRecorder(rec)
		const route = { publicArmored: 'A', routersArmoreds: 'R', fingerprint: FP }
		recordFirstPinFor(CONTACT, route)
		recordFirstPinFor('', { ...route, firstPin: true })
		recordFirstPinFor(undefined, { ...route, firstPin: true })
		expect(rec).not.toHaveBeenCalled()
		recordFirstPinFor(CONTACT, { ...route, firstPin: true })
		expect(rec).toHaveBeenCalledTimes(1)
	})
})

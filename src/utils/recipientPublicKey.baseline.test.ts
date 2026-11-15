/**
 * @jest-environment node
 */
/**
 * Review 1303e5e7, blocking an existing contact whose stored baseline came from an earlier build (an armor SHA-256) is not reported as a
 * changed key; a baseline in the OpenPGP scheme is compared. SYNTHETIC keys generated here.
 */
import { generateKey } from 'openpgp'
import { fingerprintOfArmor, refreshRecipient } from './recipientPublicKey'
import { storedKeyFingerprint } from './pgpFingerprint'

const ADDRESS = '0x2222222222222222222222222222222222222222'
let KEY_OLD = ''
let KEY_NEW = ''
let FP_OLD = ''

beforeAll(async () => {
	KEY_OLD = (await generateKey({ type: 'curve25519', userIDs: [{ name: 'old' }], format: 'armored' })).publicKey.trim()
	KEY_NEW = (await generateKey({ type: 'curve25519', userIDs: [{ name: 'new' }], format: 'armored' })).publicKey.trim()
	FP_OLD = await fingerprintOfArmor(KEY_OLD)
}, 60_000)

const fetchOf = (key: string) => async () => ({ status: 'ok' as const, publicArmored: key, routersArmoreds: 'r' })
const chatWith = (keyFingerprint?: string) => ({ address: ADDRESS, chatData: { publicArmored: KEY_OLD, routersArmoreds: 'r', keyFingerprint } })

describe('the stored baseline does not make an existing contact look changed', () => {
	it('an armor SHA-256 stored by an earlier build is no baseline: not a changed key', async () => {
		const r = await refreshRecipient(chatWith('f'.repeat(64)), fetchOf(KEY_OLD))
		expect(r).toMatchObject({ ok: true, fingerprintChanged: false, fingerprint: FP_OLD })
	})

	it('a baseline in the OpenPGP scheme with the same key is not a change', async () => {
		const r = await refreshRecipient(chatWith(storedKeyFingerprint(FP_OLD)), fetchOf(KEY_OLD))
		expect(r).toMatchObject({ ok: true, fingerprintChanged: false })
	})

	it('a baseline in the OpenPGP scheme with another key is a change', async () => {
		const r = await refreshRecipient(chatWith(storedKeyFingerprint(FP_OLD)), fetchOf(KEY_NEW))
		expect(r).toMatchObject({ ok: true, fingerprintChanged: true })
	})
})

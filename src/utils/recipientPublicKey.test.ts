/**
 * @jest-environment node
 */
/**
 * -5 (5.1): the recipient's public key for a send. The three lookup results stay apart: `ok`, `no_record`
 * (a valid empty answer) and `network_error` (a failure). A valid key in the chat copy is used without a lookup. SYNTHETIC values only.
 */
import { generateKey } from 'openpgp'
import { fingerprintOfArmor, isPgpPublicArmor, resolveRecipientPublicArmored } from './recipientPublicKey'

const ADDRESS = '0x2222222222222222222222222222222222222222'
/** A real OpenPGP public key (generated here): the fingerprint is read from it, so the armor must be a readable key. */
let ARMOR = ''
let OTHER_ARMOR = ''
beforeAll(async () => {
	ARMOR = (await generateKey({ type: 'curve25519', userIDs: [{ name: 'syn' }], format: 'armored' })).publicKey.trim()
	OTHER_ARMOR = (await generateKey({ type: 'curve25519', userIDs: [{ name: 'other' }], format: 'armored' })).publicKey.trim()
}, 60_000)
const ROUTE = 'synthetic-route'

describe('resolveRecipientPublicArmored', () => {
	it('a valid armor in the chat copy is used, and no lookup runs', async () => {
		const fetchRoute = jest.fn(async () => ({ status: 'ok' as const, publicArmored: ARMOR, routersArmoreds: ROUTE }))
		const r = await resolveRecipientPublicArmored({ address: ADDRESS, chatData: { publicArmored: ARMOR } }, fetchRoute)
		expect(r).toEqual({ ok: true, publicArmored: ARMOR })
		expect(fetchRoute).not.toHaveBeenCalled()
	})

	it('the send works when publicArmored is absent: the key comes from the lookup', async () => {
		const fetchRoute = jest.fn(async () => ({ status: 'ok' as const, publicArmored: ARMOR, routersArmoreds: ROUTE }))
		const r = await resolveRecipientPublicArmored({ address: ADDRESS, chatData: { publicArmored: '' } }, fetchRoute)
		expect(fetchRoute).toHaveBeenCalledWith(ADDRESS)
		expect(r).toEqual({ ok: true, publicArmored: ARMOR })
	})

	it('a valid empty answer is recipient_no_record, not a network error', async () => {
		const r = await resolveRecipientPublicArmored({ address: ADDRESS, chatData: {} }, async () => ({ status: 'no_record' as const }))
		expect(r).toEqual({ ok: false, code: 'recipient_no_record' })
	})

	it('a failed call is network_error, never no_record', async () => {
		const r = await resolveRecipientPublicArmored({ address: ADDRESS, chatData: {} }, async () => ({ status: 'network_error' as const, reason: 'rpc' }))
		expect(r).toEqual({ ok: false, code: 'network_error' })
	})

	it('a thrown lookup is network_error', async () => {
		const r = await resolveRecipientPublicArmored({ address: ADDRESS, chatData: {} }, async () => {
			throw new Error('rpc down')
		})
		expect(r).toEqual({ ok: false, code: 'network_error' })
	})

	it('an answer that is not a PGP public armor is recipient_key_invalid', async () => {
		const r = await resolveRecipientPublicArmored({ address: ADDRESS, chatData: {} }, async () => ({ status: 'ok' as const, publicArmored: 'garbage', routersArmoreds: ROUTE }))
		expect(r).toEqual({ ok: false, code: 'recipient_key_invalid' })
	})

	it('no address: unavailable, and no lookup runs', async () => {
		const fetchRoute = jest.fn(async () => ({ status: 'no_record' as const }))
		const r = await resolveRecipientPublicArmored({ address: '  ', chatData: {} }, fetchRoute)
		expect(r).toEqual({ ok: false, code: 'recipient_key_unavailable' })
		expect(fetchRoute).not.toHaveBeenCalled()
	})
})

describe('armor and fingerprint helpers', () => {
	it('isPgpPublicArmor accepts only a PGP public block', () => {
		expect(isPgpPublicArmor(ARMOR)).toBe(true)
		// TEST ONLY: the header below is a negative-test input. It contains no key material.
		expect(isPgpPublicArmor('-----BEGIN PGP PRIVATE KEY BLOCK-----')).toBe(false)
		expect(isPgpPublicArmor(undefined)).toBe(false)
	})

	it('the fingerprint is the OpenPGP fingerprint: stable across line endings, lowercase hex, and different for a different key', async () => {
		const fp = await fingerprintOfArmor(ARMOR)
		expect(await fingerprintOfArmor(ARMOR.replace(/\n/g, '\r\n'))).toBe(fp)
		expect(fp).toMatch(/^[0-9a-f]{40}$/)
		expect(await fingerprintOfArmor(OTHER_ARMOR)).not.toBe(fp)
	})
})

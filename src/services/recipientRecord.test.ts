/**
 * a failed AddressPGP read is network_error and never no_record; a valid empty answer is no_record. SYNTHETIC values only.
 */
import { isRecipientReadError, readRecipientRecord, RecipientReadError } from './recipientRecord'

const decode = (b64: string) => `dec:${b64}`
const KEY = 'a2V5'
const ROUTE = 'cm91dGU='

describe('readRecipientRecord (three exclusive results)', () => {
	it('an RPC throw is network_error, not no_record', async () => {
		const r = await readRecipientRecord(() => Promise.reject(new Error('could not detect network')), decode)
		expect(r).toEqual({ status: 'network_error', reason: 'could not detect network' })
	})

	it('a timeout-like throw without a message is still network_error', async () => {
		const r = await readRecipientRecord(() => Promise.reject('timeout'), decode)
		expect(r).toEqual({ status: 'network_error', reason: 'rpc' })
	})

	it('an empty answer from the provider is network_error (no answer, not a registration)', async () => {
		const r = await readRecipientRecord(() => Promise.resolve(null as never), decode)
		expect(r).toEqual({ status: 'network_error', reason: 'empty_answer' })
	})

	it('a valid empty record is no_record', async () => {
		const r = await readRecipientRecord(() => Promise.resolve({ userPublicKeyArmored: '', routePublicKeyArmored: '' }), decode)
		expect(r).toEqual({ status: 'no_record' })
	})

	it('a key and a route are ok, with the key ids', async () => {
		const r = await readRecipientRecord(
			() => Promise.resolve({ userPublicKeyArmored: KEY, routePublicKeyArmored: ROUTE, userPgpKeyID: 'AB12', routePgpKeyID: 'CD34' }),
			decode,
		)
		expect(r).toEqual({ status: 'ok', publicArmored: 'dec:a2V5', routersArmoreds: 'dec:cm91dGU=', userPgpKeyID: 'AB12', routePgpKeyID: 'CD34' })
	})

	it('a key without a route (or a route without a key) is network_error: an incomplete registration', async () => {
		expect(await readRecipientRecord(() => Promise.resolve({ userPublicKeyArmored: KEY, routePublicKeyArmored: '' }), decode)).toEqual({
			status: 'network_error',
			reason: 'incomplete_registration',
		})
		expect(await readRecipientRecord(() => Promise.resolve({ userPublicKeyArmored: '', routePublicKeyArmored: ROUTE }), decode)).toEqual({
			status: 'network_error',
			reason: 'incomplete_registration',
		})
	})

	it('an undecodable answer is network_error', async () => {
		const bad = () => {
			throw new Error('invalid base64')
		}
		const r = await readRecipientRecord(() => Promise.resolve({ userPublicKeyArmored: KEY, routePublicKeyArmored: ROUTE }), bad)
		expect(r).toEqual({ status: 'network_error', reason: 'undecodable_answer' })
	})
})

describe('RecipientReadError', () => {
	it('carries network_error and is recognised after a throw', () => {
		const e = new RecipientReadError('timeout')
		expect(e.code).toBe('network_error')
		expect(e.reason).toBe('timeout')
		expect(isRecipientReadError(e)).toBe(true)
		expect(isRecipientReadError(new Error('other'))).toBe(false)
		expect(isRecipientReadError(null)).toBe(false)
	})
})

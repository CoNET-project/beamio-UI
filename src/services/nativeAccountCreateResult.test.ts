/**
 * `nativeAccountCreateResult` acceptance (PWA side): the reqId must be the opened one; only the fields type, reqId,
 * code and eoa are allowed; the code is one of the seven; eoa only for ok, and then a lower-case address. Anything else is dropped.
 */
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: jest.fn() }), { virtual: true })

import { acceptNativeCreateResult } from './nativeRecovery'

const EOA = '0x' + 'a'.repeat(40)
const OPENED = 4242

describe('nativeAccountCreateResult is accepted only when valid', () => {
	it('an ok result with the opened reqId and a lower-case address is accepted', () => {
		expect(acceptNativeCreateResult({ type: 'nativeAccountCreateResult', reqId: OPENED, code: 'ok', eoa: EOA }, OPENED)).toEqual({
			code: 'ok',
			eoa: EOA,
		})
	})

	it('cancelled without an eoa is accepted', () => {
		expect(acceptNativeCreateResult({ type: 'nativeAccountCreateResult', reqId: OPENED, code: 'cancelled' }, OPENED)).toEqual({
			code: 'cancelled',
		})
	})

	it('a result with another reqId is discarded (3.a)', () => {
		expect(acceptNativeCreateResult({ type: 'nativeAccountCreateResult', reqId: 1, code: 'ok', eoa: EOA }, OPENED)).toBeNull()
	})

	it('no opened request means nothing is accepted', () => {
		expect(acceptNativeCreateResult({ type: 'nativeAccountCreateResult', reqId: OPENED, code: 'ok', eoa: EOA }, null)).toBeNull()
	})

	it('an extra field discards the whole event (3.b)', () => {
		expect(
			acceptNativeCreateResult({ type: 'nativeAccountCreateResult', reqId: OPENED, code: 'ok', eoa: EOA, mnemonic: 'x' }, OPENED),
		).toBeNull()
	})

	it('a code outside the five is discarded, never treated as ok (3.c)', () => {
		expect(acceptNativeCreateResult({ type: 'nativeAccountCreateResult', reqId: OPENED, code: 'done' }, OPENED)).toBeNull()
	})

	it('ok without an eoa is discarded (3.d)', () => {
		expect(acceptNativeCreateResult({ type: 'nativeAccountCreateResult', reqId: OPENED, code: 'ok' }, OPENED)).toBeNull()
	})

	it('ok with a checksummed or upper-case address is discarded (3.d)', () => {
		expect(
			acceptNativeCreateResult({ type: 'nativeAccountCreateResult', reqId: OPENED, code: 'ok', eoa: EOA.toUpperCase().replace('0X', '0x') }, OPENED),
		).toBeNull()
	})

	it('a non-ok result that carries an eoa is discarded (3.d)', () => {
		expect(
			acceptNativeCreateResult({ type: 'nativeAccountCreateResult', reqId: OPENED, code: 'already_exists', eoa: EOA }, OPENED),
		).toBeNull()
	})

	it('another event type is discarded', () => {
		expect(acceptNativeCreateResult({ type: 'nativeRecoveryResult', reqId: OPENED, code: 'ok', eoa: EOA }, OPENED)).toBeNull()
	})
})

describe('.3: already_bound and lookup_unavailable are result codes without eoa', () => {
	it('already_bound and lookup_unavailable are accepted for the opened request', () => {
		expect(acceptNativeCreateResult({ type: 'nativeAccountCreateResult', reqId: OPENED, code: 'already_bound' }, OPENED)).toEqual({
			code: 'already_bound',
		})
		expect(acceptNativeCreateResult({ type: 'nativeAccountCreateResult', reqId: OPENED, code: 'lookup_unavailable' }, OPENED)).toEqual({
			code: 'lookup_unavailable',
		})
	})

	it('they never carry an eoa: a payload with one is discarded', () => {
		expect(acceptNativeCreateResult({ type: 'nativeAccountCreateResult', reqId: OPENED, code: 'already_bound', eoa: EOA }, OPENED)).toBeNull()
		expect(acceptNativeCreateResult({ type: 'nativeAccountCreateResult', reqId: OPENED, code: 'lookup_unavailable', eoa: EOA }, OPENED)).toBeNull()
	})
})

describe('the create result never carries a private key', () => {
	it('an ok answer with a privateKeyArmor field is refused: the page reads no key from the create result', () => {
		expect(acceptNativeCreateResult({ type: 'nativeAccountCreateResult', reqId: OPENED, code: 'ok', eoa: EOA, privateKeyArmor: '0x' + '1'.repeat(64) }, OPENED)).toBeNull()
	})
})


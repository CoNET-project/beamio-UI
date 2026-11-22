/**
 * @jest-environment node
 *
 * (OB-2…OB-4),: the write_failed reason. In-vocabulary reasons are kept; a missing or out-of-vocabulary reason is
 * undefined; a reason on any other code is a shape violation. Test IDs OB-R1…OB-R4 are my own naming.
 */
import { acceptNativeCreateResult } from './nativeRecovery'

const env = (code: string, extra: Record<string, unknown> = {}, ok = false) => ({
	type: 'nativeAccountCreateResult',
	reqId: 7,
	ok,
	result: { code, ...extra },
})

describe('write_failed reason (OB-R)', () => {
	it('OB-R1: an in-vocabulary reason is kept (internal_state, storage_write, rollback_pending, old_copy_unverified)', () => {
		for (const reason of ['internal_state', 'storage_write', 'rollback_pending', 'old_copy_unverified']) {
			expect(acceptNativeCreateResult(env('write_failed', { reason }), 7)).toEqual({ code: 'write_failed', reason })
		}
	})

	it('OB-R2: a missing reason, or one outside the vocabulary, is undefined (the conservative case)', () => {
		expect(acceptNativeCreateResult(env('write_failed'), 7)).toEqual({ code: 'write_failed' })
		expect(acceptNativeCreateResult(env('write_failed', { reason: 'something_else' }), 7)).toEqual({ code: 'write_failed' })
	})

	it('OB-R3: a reason on a code other than write_failed is a shape violation (null)', () => {
		expect(acceptNativeCreateResult(env('cancelled', { reason: 'internal_state' }), 7)).toBeNull()
		expect(acceptNativeCreateResult(env('already_exists', { reason: 'internal_state' }), 7)).toBeNull()
	})

	it('OB-R4: regression: write_failed without a reason still parses as write_failed', () => {
		expect(acceptNativeCreateResult(env('write_failed', {}), 7)).toEqual({ code: 'write_failed' })
	})
})

describe('CT-11: a late result of an old request is rejected by the reqId check', () => {
	it('a result whose reqId is not the currently opened request is dropped (null)', () => {
		expect(acceptNativeCreateResult(env('ok', { eoa: '0x' + 'ab'.repeat(20) }, true), 8)).toBeNull()
		expect(acceptNativeCreateResult(env('write_failed', {}), 8)).toBeNull()
	})
})

describe('already_exists with an eoa is never a success (OB-AE)', () => {
	it('OB-AE1: already_exists carrying an eoa is returned as already_exists with the eoa dropped (no success basis)', () => {
		const withEoa = { type: 'nativeAccountCreateResult', reqId: 7, ok: false, result: { code: 'already_exists', eoa: '0x' + 'ab'.repeat(20) } }
		expect(acceptNativeCreateResult(withEoa, 7)).toEqual({ code: 'already_exists' })
	})

	it('OB-AE2: the only success code is ok; already_exists is never mapped to ok', () => {
		const withEoa = { type: 'nativeAccountCreateResult', reqId: 7, ok: false, result: { code: 'already_exists', eoa: '0x' + 'ab'.repeat(20) } }
		expect(acceptNativeCreateResult(withEoa, 7)?.code).not.toBe('ok')
	})
})

/**
 * `nativeAccountCreateResult` acceptance, nested shape (r11 §10, §11, §12; plan IDs NR-*, AND-SHAPE-*).
 * Shape: {type, reqId, ok, result:{code, eoa?, cleanupPending?, W?}}. Top-level keys: type, reqId, ok, result.
 * W fields (privateKeyArmor, mnemonicPhrase, recoveryWords) are accepted on ok only and dropped at once.
 * Synthetic values only.
 */
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: jest.fn() }), { virtual: true })

import { acceptNativeCreateResult } from './nativeRecovery'

const EOA = '0x' + 'a'.repeat(40)
const OPENED = 4242
const ev = (ok: boolean, result: Record<string, unknown>, extra: Record<string, unknown> = {}, reqId: number = OPENED) => ({
	type: 'nativeAccountCreateResult',
	reqId,
	ok,
	result,
	...extra,
})
const W = { privateKeyArmor: 'SYNTHETIC-ARMOR', mnemonicPhrase: 'synthetic words', recoveryWords: ['a', 'b'] }

describe('NR-1..NR-7: nested acceptance and the eoa rules', () => {
	it('NR-6: ok with the opened reqId and a lower-case eoa is accepted', () => {
		expect(acceptNativeCreateResult(ev(true, { code: 'ok', eoa: EOA }), OPENED)).toEqual({ code: 'ok', eoa: EOA })
	})
	it('NR-1: already_exists with an eoa gives already_exists; the eoa is not kept', () => {
		expect(acceptNativeCreateResult(ev(false, { code: 'already_exists', eoa: EOA }), OPENED)).toEqual({ code: 'already_exists' })
	})
	it('NR-2: already_exists without an eoa gives already_exists', () => {
		expect(acceptNativeCreateResult(ev(false, { code: 'already_exists' }), OPENED)).toEqual({ code: 'already_exists' })
	})
	it('NR-3: cancelled with an eoa is discarded', () => {
		expect(acceptNativeCreateResult(ev(false, { code: 'cancelled', eoa: EOA }), OPENED)).toBeNull()
	})
	it('NR-4: write_failed with an eoa is discarded', () => {
		expect(acceptNativeCreateResult(ev(false, { code: 'write_failed', eoa: EOA }), OPENED)).toBeNull()
	})
	it('NR-5 (= CT-5): not_ready with an eoa gives not_ready; the eoa is dropped', () => {
		expect(acceptNativeCreateResult(ev(false, { code: 'not_ready', eoa: EOA }), OPENED)).toEqual({ code: 'not_ready' })
	})
	it('NR-7: ok without a valid eoa is discarded', () => {
		expect(acceptNativeCreateResult(ev(true, { code: 'ok' }), OPENED)).toBeNull()
		expect(acceptNativeCreateResult(ev(true, { code: 'ok', eoa: '0xABC' }), OPENED)).toBeNull()
	})
})

describe('NR-8..NR-11: keys, reqId, and the code set', () => {
	it('NR-8: an unknown top-level key discards the event', () => {
		expect(acceptNativeCreateResult(ev(true, { code: 'ok', eoa: EOA }, { foo: 1 }), OPENED)).toBeNull()
	})
	it('NR-8b: an unknown key inside result discards the event', () => {
		expect(acceptNativeCreateResult(ev(true, { code: 'ok', eoa: EOA, bar: 1 }), OPENED)).toBeNull()
	})
	it('NR-10: a reqId that is not the opened one is discarded', () => {
		expect(acceptNativeCreateResult(ev(true, { code: 'ok', eoa: EOA }, {}, OPENED + 1), OPENED)).toBeNull()
	})
	it('NR-11: not_ready is in the result code set and accepted', () => {
		expect(acceptNativeCreateResult(ev(false, { code: 'not_ready' }), OPENED)).toEqual({ code: 'not_ready' })
	})
	it('a code outside the set is discarded, never treated as ok', () => {
		expect(acceptNativeCreateResult(ev(false, { code: 'bogus' }), OPENED)).toBeNull()
	})
	it('no opened request means nothing is accepted', () => {
		expect(acceptNativeCreateResult(ev(true, { code: 'ok', eoa: EOA }), null)).toBeNull()
	})
})

describe('NR-9, NR-12, NR-18, NR-19: W fields are accepted on ok and dropped at once', () => {
	it('NR-9: ok with cleanupPending is accepted and cleanupPending does not change the result', () => {
		expect(acceptNativeCreateResult(ev(true, { code: 'ok', eoa: EOA, cleanupPending: true }), OPENED)).toEqual({ code: 'ok', eoa: EOA })
	})
	it('NR-18: ok carrying the three W keys is accepted, and the result holds none of them', () => {
		const out = acceptNativeCreateResult(ev(true, { code: 'ok', eoa: EOA, ...W }), OPENED)
		expect(out).toEqual({ code: 'ok', eoa: EOA })
		const text = JSON.stringify(out)
		for (const k of ['privateKeyArmor', 'mnemonicPhrase', 'recoveryWords', 'SYNTHETIC-ARMOR', 'synthetic words']) expect(text).not.toContain(k)
		expect(Object.keys(out as object).sort()).toEqual(['code', 'eoa'])
	})
	it('NR-19a/b/c: each W key on its own is stripped', () => {
		for (const k of Object.keys(W)) {
			const out = acceptNativeCreateResult(ev(true, { code: 'ok', eoa: EOA, [k]: (W as Record<string, unknown>)[k] }), OPENED)
			expect(out).toEqual({ code: 'ok', eoa: EOA })
		}
	})
	it('NR-12: a W key is accepted for ok only; the result never carries it', () => {
		expect(acceptNativeCreateResult(ev(true, { code: 'ok', eoa: EOA, privateKeyArmor: 'x' }), OPENED)).not.toHaveProperty('privateKeyArmor')
	})
})

describe('NR-20, NR-21: W keys on a non-ok result are an unknown key (discarded, not accepted)', () => {
	it('NR-20: a non-ok result carrying a W key is discarded for every code', () => {
		for (const code of ['cancelled', 'write_failed', 'readback_failed', 'already_bound', 'lookup_unavailable', 'not_ready', 'already_exists']) {
			for (const k of Object.keys(W)) {
				expect(acceptNativeCreateResult(ev(false, { code, [k]: (W as Record<string, unknown>)[k] }), OPENED)).toBeNull()
			}
		}
	})
	it('NR-21: already_exists and not_ready with a W key are discarded (no exception by code)', () => {
		expect(acceptNativeCreateResult(ev(false, { code: 'already_exists', recoveryWords: ['a'] }), OPENED)).toBeNull()
		expect(acceptNativeCreateResult(ev(false, { code: 'not_ready', mnemonicPhrase: 'x' }), OPENED)).toBeNull()
	})
});

describe('NR-13, NR-14: the ok / code consistency guard reports a shape violation (never accepted as success)', () => {
	it('NR-13 / NR-13b: ok true with a non-ok code is a shape violation (category only)', () => {
		expect(acceptNativeCreateResult(ev(true, { code: 'cancelled' }), OPENED)).toEqual({ code: 'shape_violation', reason: 'ok_code_mismatch' })
	})
	it('NR-14 / NR-14b: ok false with code ok is a shape violation', () => {
		expect(acceptNativeCreateResult(ev(false, { code: 'ok', eoa: EOA }), OPENED)).toEqual({ code: 'shape_violation', reason: 'ok_code_mismatch' })
	})
});

describe('NR-15: cleanupPending is parsed and does not change the result', () => {
	it('NR-15: already_exists with cleanupPending gives already_exists', () => {
		expect(acceptNativeCreateResult(ev(false, { code: 'already_exists', cleanupPending: false }), OPENED)).toEqual({ code: 'already_exists' })
	})
});

describe('AND-SHAPE: the Android shapes are accepted', () => {
	it('AND-SHAPE-1: ok with cleanupPending is accepted', () => {
		expect(acceptNativeCreateResult(ev(true, { code: 'ok', eoa: EOA, cleanupPending: true }), OPENED)).toEqual({ code: 'ok', eoa: EOA })
	})
	it('AND-SHAPE-2: already_exists with cleanupPending (no eoa) is accepted', () => {
		expect(acceptNativeCreateResult(ev(false, { code: 'already_exists', cleanupPending: true }), OPENED)).toEqual({ code: 'already_exists' })
	})
	it('AND-SHAPE-3: ok with a W key is accepted and stripped', () => {
		expect(acceptNativeCreateResult(ev(true, { code: 'ok', eoa: EOA, privateKeyArmor: 'x' }), OPENED)).toEqual({ code: 'ok', eoa: EOA })
	})
});

describe('already_bound and lookup_unavailable carry no eoa (the opened ack is page:none; not this parser)', () => {
	it('already_bound and lookup_unavailable are accepted without an eoa', () => {
		expect(acceptNativeCreateResult(ev(false, { code: 'already_bound' }), OPENED)).toEqual({ code: 'already_bound' })
		expect(acceptNativeCreateResult(ev(false, { code: 'lookup_unavailable' }), OPENED)).toEqual({ code: 'lookup_unavailable' })
	})
	it('a flat payload (the old shape) is discarded', () => {
		expect(acceptNativeCreateResult({ type: 'nativeAccountCreateResult', reqId: OPENED, code: 'ok', eoa: EOA }, OPENED)).toBeNull()
	})
});

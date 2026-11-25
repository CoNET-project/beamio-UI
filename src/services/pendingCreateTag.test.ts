/**
 * The pending record of an interrupted create (0.53.51): { [eoa]: { t, s?, a? } } with non-secret values only; a plain string value is the older
 * format (tag only, s unknown). SYNTHETIC values only.
 */
import { clearPendingCreateTag, markPendingForwardAccepted, markPendingForwardSent, readPendingCreateRecord, readPendingCreateTag, writePendingCreateTag } from './pendingCreateTag'

const KEY = 'beamio.pendingCreateTag.v2'
const E1 = '0x' + '1'.repeat(40)
const E2 = '0x' + '2'.repeat(40)
const raw = () => JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>

beforeEach(() => localStorage.clear())

describe('formats', () => {
	it('a written record is { t } and reads as a non-legacy record without s and a', () => {
		writePendingCreateTag(E1, '@synthtag')
		expect(raw()).toEqual({ [E1]: { t: 'synthtag' } })
		expect(readPendingCreateRecord(E1)).toEqual({ tag: 'synthtag', legacy: false })
		expect(readPendingCreateTag(E1)).toBe('synthtag')
	})

	it('a plain string value is the older format: a tag with s unknown (legacy)', () => {
		localStorage.setItem(KEY, JSON.stringify({ [E1]: 'oldtag' }))
		expect(readPendingCreateRecord(E1)).toEqual({ tag: 'oldtag', legacy: true })
		// a later write for the same wallet turns it into the new format
		writePendingCreateTag(E1, 'oldtag')
		expect(raw()).toEqual({ [E1]: { t: 'oldtag' } })
	})

	it('junk is dropped: bad eoa key, empty tag, non-object values, bad times', () => {
		localStorage.setItem(KEY, JSON.stringify({ nope: 'x', [E1]: { t: '' }, [E2]: { t: 'ok', s: -5, a: 'x' } }))
		expect(readPendingCreateRecord(E1)).toBeNull()
		expect(readPendingCreateRecord(E2)).toEqual({ tag: 'ok', legacy: false })
		localStorage.setItem(KEY, 'not json')
		expect(readPendingCreateRecord(E1)).toBeNull()
	})

	it('s and a must be positive integers', () => {
		localStorage.setItem(KEY, JSON.stringify({ [E1]: { t: 'x', s: 1.5, a: 0 }, [E2]: { t: 'y', s: 1700000000000, a: 1700000000500 } }))
		expect(readPendingCreateRecord(E1)).toEqual({ tag: 'x', legacy: false })
		expect(readPendingCreateRecord(E2)).toEqual({ tag: 'y', s: 1700000000000, a: 1700000000500, legacy: false })
	})
})

describe('s and a', () => {
	it('markPendingForwardSent sets s; a new send cycle drops an older a; markPendingForwardAccepted sets a', () => {
		writePendingCreateTag(E1, 'synthtag')
		markPendingForwardSent(E1, 1700000000000)
		expect(raw()).toEqual({ [E1]: { t: 'synthtag', s: 1700000000000 } })
		markPendingForwardAccepted(E1, 1700000000800)
		expect(raw()).toEqual({ [E1]: { t: 'synthtag', s: 1700000000000, a: 1700000000800 } })
		markPendingForwardSent(E1, 1700000009000)
		expect(raw()).toEqual({ [E1]: { t: 'synthtag', s: 1700000009000 } })
	})

	it('writing the same tag again (a retry of step 1) keeps s and a; another tag starts clean', () => {
		writePendingCreateTag(E1, 'synthtag')
		markPendingForwardSent(E1, 1700000000000)
		markPendingForwardAccepted(E1, 1700000000800)
		writePendingCreateTag(E1, 'synthtag')
		expect(raw()).toEqual({ [E1]: { t: 'synthtag', s: 1700000000000, a: 1700000000800 } })
		writePendingCreateTag(E1, 'another')
		expect(raw()).toEqual({ [E1]: { t: 'another' } })
	})

	it('marks without a record, or with a bad time, do nothing', () => {
		markPendingForwardSent(E1, 1700000000000)
		markPendingForwardAccepted(E1, 1700000000000)
		expect(localStorage.getItem(KEY)).toBeNull()
		writePendingCreateTag(E1, 'synthtag')
		markPendingForwardSent(E1, -1)
		markPendingForwardAccepted(E1, NaN)
		expect(raw()).toEqual({ [E1]: { t: 'synthtag' } })
	})
})

describe('non-secret only, bounded, clearable', () => {
	it('the stored values hold only t, s, a', () => {
		writePendingCreateTag(E1, 'synthtag')
		markPendingForwardSent(E1, 1700000000000)
		markPendingForwardAccepted(E1, 1700000000800)
		for (const v of Object.values(raw())) expect(Object.keys(v as object).sort()).toEqual(['a', 's', 't'])
	})

	it('only the newest 8 wallets are kept', () => {
		for (let i = 1; i <= 10; i++) writePendingCreateTag('0x' + i.toString(16).padStart(40, '0'), `tag${i}`)
		expect(Object.keys(raw())).toHaveLength(8)
		expect(readPendingCreateTag('0x' + (1).toString(16).padStart(40, '0'))).toBe('')
		expect(readPendingCreateTag('0x' + (10).toString(16).padStart(40, '0'))).toBe('tag10')
	})

	it('clear removes one wallet and the key when the last one goes', () => {
		writePendingCreateTag(E1, 'a1')
		writePendingCreateTag(E2, 'b2')
		clearPendingCreateTag(E1)
		expect(Object.keys(raw())).toEqual([E2])
		clearPendingCreateTag(E2)
		expect(localStorage.getItem(KEY)).toBeNull()
	})
})

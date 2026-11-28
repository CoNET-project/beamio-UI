/**
 * @jest-environment node
 */
// the read-only account-level persistence probe of the hook variant: libraryPersistExplain says WHY libraryPersistModeFor answers what it answers, and the two never disagree. SYNTHETIC only.
import { readFileSync } from 'fs'
import { join } from 'path'
import { CHAT_BODIES_PURGED_KEY, libraryPersistExplain, libraryPersistModeFor, noteLibraryEvidence, profileEoaOf, resetLibraryEvidenceForTest } from './chatLocalPurge'

const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'
let flagOf: string | null = null
beforeEach(() => {
	resetLibraryEvidenceForTest()
	flagOf = null
	;(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => (k === CHAT_BODIES_PURGED_KEY ? flagOf : null), setItem: () => undefined, removeItem: () => undefined }
})

describe('libraryPersistExplain', () => {
	it('its mode IS libraryPersistModeFor for every combination of flag, evidence (none, other account, present: capable x state), and no account', () => {
		const states: Array<string | null> = [null, 'none', 'running', 'complete', 'switched', 'purged', 'future_state']
		const evidences: Array<null | { eoa: string; capable: boolean; state: string | null }> = [null, { eoa: B, capable: true, state: 'purged' }]
		for (const capable of [true, false]) for (const state of states) evidences.push({ eoa: A, capable, state })
		for (const flag of [null, A, B]) {
			for (const ev of evidences) {
				resetLibraryEvidenceForTest()
				flagOf = flag
				if (ev) noteLibraryEvidence(ev)
				for (const eoa of [A, A.toUpperCase().replace('0X', '0x'), '']) expect(libraryPersistExplain(eoa).mode).toBe(libraryPersistModeFor(eoa))
			}
		}
	})
	it('the reasons: flag in place; no evidence; evidence of another account; capable and state of this account (state null = asked, no answer); no account', () => {
		expect(libraryPersistExplain('')).toEqual({ mode: 'record', flag: false, capable: null, state: null, evidence: 'no_account' })
		expect(libraryPersistExplain(A)).toEqual({ mode: 'record', flag: false, capable: null, state: null, evidence: 'none' })
		noteLibraryEvidence({ eoa: B, capable: true, state: 'purged' })
		expect(libraryPersistExplain(A)).toEqual({ mode: 'record', flag: false, capable: null, state: null, evidence: 'other_account' })
		noteLibraryEvidence({ eoa: A, capable: true, state: null })
		expect(libraryPersistExplain(A)).toEqual({ mode: 'guarded', flag: false, capable: true, state: null, evidence: 'present' })
		noteLibraryEvidence({ eoa: A, capable: true, state: 'switched' })
		expect(libraryPersistExplain(A)).toEqual({ mode: 'guarded', flag: false, capable: true, state: 'switched', evidence: 'present' })
		noteLibraryEvidence({ eoa: A, capable: true, state: 'complete' })
		expect(libraryPersistExplain(A)).toMatchObject({ mode: 'record', state: 'complete' })
		flagOf = A
		expect(libraryPersistExplain(A)).toMatchObject({ mode: 'library', flag: true })
		resetLibraryEvidenceForTest()
		noteLibraryEvidence({ eoa: A, capable: false, state: null }) // a native shell: no library client
		flagOf = null
		expect(libraryPersistExplain(A)).toEqual({ mode: 'record', flag: false, capable: false, state: null, evidence: 'present' })
	})
	it('it reads only: calling it changes neither the evidence nor the mode', () => {
		noteLibraryEvidence({ eoa: A, capable: true, state: 'purged' })
		const before = libraryPersistModeFor(A)
		for (let i = 0; i < 3; i++) libraryPersistExplain(A)
		expect(libraryPersistModeFor(A)).toBe(before)
	})
})

/**
 * @jest-environment node
 */
/**
 * Spec item 60(7): the pre-read vectors NP-01 to NP-13 (mnemonic-preread-vectors.v1.json, sha256 pinned below). Each case's
 * `expect` is the native answer; the page maps every answer through prereadFromAnswer. SYNTHETIC values only.
 */
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { prereadFromAnswer } from './nativeRecovery'

const VECTOR_FILE = join(__dirname, '__fixtures__', 'mnemonic-preread-vectors.v1.json')
const PINNED_SHA256 = '100dc8d566cd8f7bb832399513ba015a5ba791383d8debe4c7b0f59d6ef73827'

type Expect = { ok: boolean; result?: { state?: string; eoa?: string; phrase?: string }; error?: string }
type Case = { id: string; expect: Expect[] }

const raw = readFileSync(VECTOR_FILE)
const doc = JSON.parse(raw.toString('utf8')) as { cases: Case[]; selfCheck: { cases: number; result: string } }

describe('nativeMnemonicPreread vectors', () => {
	it('the vector file is the pinned copy (sha256 100dc8d5...3827) with 13 cases', () => {
		expect(createHash('sha256').update(raw).digest('hex')).toBe(PINNED_SHA256)
		expect(doc.cases).toHaveLength(13)
		expect(doc.selfCheck).toEqual({ cases: 13, result: 'pass' })
	})

	it('every native answer in NP-01 to NP-13 maps to the page outcome the spec gives', () => {
		const ids = doc.cases.map((c) => c.id)
		expect(ids).toEqual(Array.from({ length: 13 }, (_, i) => `NP-${String(i + 1).padStart(2, '0')}`))
		for (const c of doc.cases) {
			for (const e of c.expect) {
				const mapped = prereadFromAnswer({ kind: 'payload', payload: { type: 'ack', ok: e.ok, result: e.result, error: e.error } })
				if (!e.ok) {
					// stale_seq, bad_request, untrusted_source: never absent, never valid
					expect({ id: c.id, kind: mapped.kind }).toEqual({ id: c.id, kind: 'unknown' })
				} else if (e.result?.state === 'absent') {
					expect({ id: c.id, kind: mapped.kind }).toEqual({ id: c.id, kind: 'absent' })
				} else if (e.result?.state === 'unknown') {
					expect({ id: c.id, kind: mapped.kind }).toEqual({ id: c.id, kind: 'unknown' })
				} else if (e.result?.state === 'valid') {
					// the synthetic phrase is not a mnemonic that derives the synthetic EOA: the page never accepts it as valid
					expect({ id: c.id, kind: mapped.kind }).toEqual({ id: c.id, kind: 'unknown' })
				} else {
					throw new Error(`unexpected expect shape in ${c.id}`)
				}
			}
		}
	})
})

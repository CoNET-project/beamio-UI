/**
 * @jest-environment node
 */
/**
 * Spec r2.5.19 item 60(7): the pre-read vectors NP-01 to NP-13 (mnemonic-preread-vectors.v1.json, sha256 pinned below). Each case's
 * `expect` is the native answer; the page maps every answer through prereadFromAnswer. SYNTHETIC values only.
 */
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { prereadFromAnswer } from './nativeRecovery'

const VECTOR_FILE = join(__dirname, '__fixtures__', 'mnemonic-preread-vectors.v1.json')
const PINNED_SHA256 = 'c90b54897827d303d0b9566595b498685d024cefe3ae062ba39e2bec4e4039f9'

type Expect = { ok: boolean; result?: { state?: string; eoa?: string; phrase?: string }; error?: string }
type Case = { id: string; expect: Expect[] }

const raw = readFileSync(VECTOR_FILE)
const doc = JSON.parse(raw.toString('utf8')) as { cases: Case[]; selfCheck: { cases: number; result: string } }

describe('nativeMnemonicPreread vectors (r2.5.19 item 60)', () => {
	it('the vector file is the pinned copy (sha256 c90b5489...39f9) with 13 cases', () => {
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
				} else if (e.result?.state !== undefined) {
					// 2026-11-22 item 3: the state shape is not a shipped shape and is not read: unknown (the closed set is result.code)
					expect({ id: c.id, kind: mapped.kind }).toEqual({ id: c.id, kind: 'unknown' })
				} else {
					throw new Error(`unexpected expect shape in ${c.id}`)
				}
			}
		}
	})
})

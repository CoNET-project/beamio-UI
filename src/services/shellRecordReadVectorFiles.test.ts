/**
 * v4: the shellRecordRead answer cases are read directly from the spec vector files,
 * never transcribed by hand. Authority: the answer-shape v1 vector and the v2 files
 * The v1 not-ready and unreadable-cause files are superseded and are not read here.
 * The files are checked in under __fixtures__/shell-record-read. A missing file fails the test.
 */
import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { parseShellRecordRead, shellRecordAsWalletRecord } from './shellRecordStore'
import { NOT_READY_BOUNDED_DELAYS_MS, shellStorageErrorReason } from './shellStoreWait'

// the vector files are checked in beside this test, byte for byte; they are read from the repository only (no path outside it)
const VECTOR_DIR = join(__dirname, '__fixtures__', 'shell-record-read')
/** The SHA256 of each checked-in file (answer-shape v1 898ff403…a217e; not-ready-reasons v2 797a5370…23b9; unreadable-cause v2 e1c626f0…7ade4). */
const FILES: ReadonlyArray<{ name: string; sha256: string }> = [
	{ name: 'shell-record-read-answer-shape-v1.json', sha256: '898ff403e9d53a9ca42c2226fbbcaee3138dee3f398bd1e2e1ea6250821a217e' },
	{ name: 'shell-record-read-not-ready-reasons-v2.json', sha256: '797a5370ac12aae7a79ac0d7a73173986dc459cb0c33757a1d95d0f7186f23b9' },
	{ name: 'unreadable-cause-v2.json', sha256: 'e1c626f0d7d62c7f78a8e7c082b89ad6f168b6bdaeb6733ae91797108d57ade4' },
]

type Case = { id: string; command?: string; expect: Record<string, unknown> }
const loaded = FILES.map((f) => {
	const path = join(VECTOR_DIR, f.name)
	if (!existsSync(path)) throw new Error(`spec vector missing: ${path}`)
	const raw = readFileSync(path)
	const digest = createHash('sha256').update(raw).digest('hex')
	if (digest !== f.sha256) throw new Error(`spec vector ${f.name} does not match its pinned SHA256 (${digest})`)
	const j = JSON.parse(raw.toString('utf8')) as { cases: Case[] }
	return { file: f.name, cases: j.cases }
})

/** The storage reason a read of this answer ends with (the thrown message mapped by the storage entry), or 'absent' / 'loaded' / 'other'. */
function endOf(payload: Record<string, unknown>): string {
	const parsed = parseShellRecordRead(payload)
	if (parsed.status === 'absent') return 'absent'
	if (parsed.status !== 'error') return 'loaded'
	try {
		shellRecordAsWalletRecord(parsed as never)
		return 'other'
	} catch (err) {
		return shellStorageErrorReason((err as Error).message)
	}
}

describe('vector files exist, match their pinned SHA256 and parse (answer-shape v1, not-ready-reasons v2, unreadable-cause v2)', () => {
	it('all three authority files are present, pinned and non-empty', () => {
		for (const v of loaded) expect(v.cases.length).toBeGreaterThan(0)
	})
	it('no path outside the repository is read (no private folder, no environment fallback)', () => {
		expect(VECTOR_DIR.startsWith(__dirname)).toBe(true)
		expect(VECTOR_DIR).toBe(join(__dirname, '__fixtures__', 'shell-record-read'))
	})
})

describe('each vector case, read from the file', () => {
	for (const v of loaded) {
		for (const c of v.cases) {
			it(`${v.file} :: ${c.id}`, () => {
				const exp = c.expect as Record<string, unknown>
				const result = (exp.result ?? {}) as Record<string, unknown>
				const code = result.code as string | undefined
				if (exp.ok === false) {
					// envelope-level refusals
					const want = exp.error === 'origin_refused' ? 'app_update_required' : exp.error === 'bad_request' ? 'native_record' : null
					if (want) expect(endOf(exp)).toBe(want)
					return
				}
				if (code === 'absent') {
					expect(endOf(exp)).toBe('absent')
				} else if (code === 'not_ready') {
					const retryable = result.retryable as boolean
					expect(endOf(exp)).toBe(retryable ? 'native_not_ready_bounded' : 'native_not_ready_final')
					const parsed = parseShellRecordRead(exp)
					expect(parsed).toMatchObject({ status: 'error', reason: 'not_ready', notReady: { retryable, persistent: false } })
				} else if (code === 'error' && result.sub === 'not_ready_persistent') {
					expect(endOf(exp)).toBe('native_not_ready_final')
					expect(parseShellRecordRead(exp)).toMatchObject({ status: 'error', reason: 'not_ready_persistent', notReady: { persistent: true } })
				} else if (code === 'error' && result.sub === 'record_unreadable') {
					expect(endOf(exp)).toBe('native_reading')
				} else if (code === 'migrating') {
					expect(endOf(exp)).toBe('native_retry')
				} else if (code === 'ok') {
					// a loaded record needs its full record body (covered by the shellRecordStore suites); here only: not absent, not a hold
					expect(endOf(exp)).not.toBe('absent')
				} else {
					throw new Error(`unrecognised vector case ${c.id} in ${v.file}`)
				}
			})
		}
	}
})

describe('the vector files are internally consistent (their own forbidden rules)', () => {
	for (const v of loaded) {
		for (const c of v.cases) {
			const result = ((c.expect as Record<string, unknown>).result ?? {}) as Record<string, unknown>
			const reason = result.notReadyReason as string | undefined
			if (!reason) continue
			it(`${v.file} :: ${c.id} retryable matches its reason`, () => {
				if (reason === 'storage_locked' || reason === 'ambiguous_accounts') expect(result.retryable).toBe(false)
				if (reason === 'g1_uninitialized') expect(result.retryable).toBe(true)
				if (result.unreadableCause === 'entitlement' || result.unreadableCause === 'other') expect(result.retryable).toBe(false)
				if (result.unreadableCause === 'device_locked') expect(result.retryable).toBe(true)
				if (result.unreadableCause !== undefined) expect(['entitlement', 'device_locked', 'other']).toContain(result.unreadableCause)
			})
		}
	}
})

describe('the ceiling timetable', () => {
	it('zero: no automatic re-read (retryable false → native_not_ready_final at once)', () => {
		const zero = loaded.flatMap((v) => v.cases).find((c) => (c.expect as { result?: { retryable?: boolean } }).result?.retryable === false && (c.expect as { result?: { code?: string } }).result?.code === 'not_ready')
		expect(zero).toBeDefined()
		expect(endOf(zero!.expect as Record<string, unknown>)).toBe('native_not_ready_final')
	})
	it('bounded: five re-reads at 0.5, 1, 2, 4, 8 s, then the explicit final (never a sixth automatic read)', () => {
		expect([...NOT_READY_BOUNDED_DELAYS_MS]).toEqual([500, 1000, 2000, 4000, 8000])
	})
	it('persistent after ten identical reasons in a row: explicit final, no automatic retry', () => {
		const persistent = loaded.flatMap((v) => v.cases).filter((c) => (c.expect as { result?: { sub?: string } }).result?.sub === 'not_ready_persistent')
		expect(persistent.length).toBeGreaterThan(0)
		for (const c of persistent) expect(endOf(c.expect as Record<string, unknown>)).toBe('native_not_ready_final')
	})
	it('SHAPE-02 loaded: the full structure is compared (result.code ok, rev, schemaVersion, record) and a loaded answer is not a hold', () => {
		const shape = loaded[0].cases
		const exp = shape.find((c) => c.id === 'SHAPE-02-loaded')!.expect as { type: string; ok: boolean; result: Record<string, unknown> }
		expect(exp.type).toBe('ack')
		expect(exp.ok).toBe(true)
		expect(Object.keys(exp.result).sort()).toEqual(['code', 'record', 'rev', 'schemaVersion'])
		expect(exp.result.code).toBe('ok')
		expect(exp.result.rev).toBe('<int>')
		expect(exp.result.schemaVersion).toBe('<int>')
		expect(exp.result.record).toBe('<object>')
		// filled with the placeholder types: an integer rev and schemaVersion, an object record; the parser takes the ok branch (not absent, not a hold)
		const filled = { type: 'ack', ok: true, result: { code: 'ok', rev: 1, schemaVersion: 1, record: { profiles: [] } } }
		const parsed = parseShellRecordRead(filled)
		expect(parsed.status).not.toBe('absent')
		expect(parsed.status === 'error' ? parsed.reason : '').not.toMatch(/not_ready|migrating/)
		expect(endOf(exp as unknown as Record<string, unknown>)).not.toBe('absent')
		expect(endOf(shape.find((c) => c.id === 'SHAPE-03-migrating')!.expect as Record<string, unknown>)).toBe('native_retry')
		expect(endOf(shape.find((c) => c.id === 'SHAPE-10-origin_refused')!.expect as Record<string, unknown>)).toBe('app_update_required')
		expect(endOf(shape.find((c) => c.id === 'SHAPE-11-bad_request-extra-field')!.expect as Record<string, unknown>)).toBe('native_record')
	})
})

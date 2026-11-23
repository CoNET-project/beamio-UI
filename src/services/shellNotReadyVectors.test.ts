import { diagnosticCode } from './diagnosticCodes'
/**
 * v4 (2026-11-21): the shellRecordRead not_ready shape and its ceilings, checked against the three spec vectors:
 * - the vector file (SHAPE-01..11);
 * - the vector file (SRR-01..07);
 * - the vector file (UNR-01..05).
 * not_ready is result.code under ok:true; not_ready_persistent is result.code "error" with sub; origin_refused and bad_request are
 * envelope-level ok:false. Each case below names its vector id.
 */
import { parseShellRecordRead, shellRecordAsWalletRecord } from './shellRecordStore'
import { notReadyClass, NOT_READY_BOUNDED_DELAYS_MS, shellStorageErrorReason } from './shellStoreWait'
import { emptyReadAction, resetShellTerminalState, setShellReadHold } from './shellTerminalState'

const ack = (result: Record<string, unknown>) => ({ type: 'ack', ok: true, result })
/** The reason a read of this answer ends with, as the storage entry sees it (the thrown message, mapped). */
function storageReasonOf(payload: unknown): string | null {
	const parsed = parseShellRecordRead(payload as Record<string, unknown>)
	if (parsed.status !== 'error') return parsed.status
	try {
		shellRecordAsWalletRecord({ status: 'error', reason: parsed.reason, notReady: parsed.notReady } as never)
		return null
	} catch (err) {
		return shellStorageErrorReason((err as Error).message)
	}
}

describe('v4 not_ready shape (ok:true, result.code)', () => {
	it('SHAPE-04 storage_locked (retryable false): explicit at once, zero automatic retries', () => {
		const p = ack({ code: 'not_ready', notReadyReason: 'storage_locked', retryable: false })
		expect(parseShellRecordRead(p)).toMatchObject({ status: 'error', reason: 'not_ready', notReady: { notReadyReason: 'storage_locked', retryable: false, persistent: false } })
		expect(storageReasonOf(p)).toBe('native_not_ready_final')
	})
	it('SRR-02 / SHAPE-05 g1_uninitialized (retryable true): bounded (5 re-reads, then explicit)', () => {
		const p = ack({ code: 'not_ready', notReadyReason: 'g1_uninitialized', retryable: true })
		expect(storageReasonOf(p)).toBe('native_not_ready_bounded')
	})
	it('SRR-03 / SHAPE-06 ambiguous_accounts (retryable false): explicit at once', () => {
		expect(storageReasonOf(ack({ code: 'not_ready', notReadyReason: 'ambiguous_accounts', retryable: false }))).toBe('native_not_ready_final')
	})
	it('UNR-01 / SHAPE-07 unreadable, cause entitlement (retryable false): explicit at once', () => {
		expect(storageReasonOf(ack({ code: 'not_ready', notReadyReason: 'unreadable', unreadableCause: 'entitlement', retryable: false }))).toBe('native_not_ready_final')
	})
	it('UNR-02 unreadable, cause device_locked (retryable true): bounded', () => {
		expect(storageReasonOf(ack({ code: 'not_ready', notReadyReason: 'unreadable', unreadableCause: 'device_locked', retryable: true }))).toBe('native_not_ready_bounded')
	})
	it('UNR-03 unreadable, cause other (retryable false): explicit at once; a non-boolean retryable is explicit too (never endless)', () => {
		expect(storageReasonOf(ack({ code: 'not_ready', notReadyReason: 'unreadable', unreadableCause: 'other', retryable: false }))).toBe('native_not_ready_final')
		expect(storageReasonOf(ack({ code: 'not_ready', notReadyReason: 'g1_uninitialized', retryable: 'yes' }))).toBe('native_not_ready_final')
	})
})

describe('v4 not_ready_persistent (result.code "error", sub)', () => {
	it('SHAPE-08 / SRR-04 / SRR-05 / UNR-04: persistent, explicit, no automatic retry', () => {
		const p = ack({ code: 'error', sub: 'not_ready_persistent', notReadyReason: 'storage_locked', retryable: false })
		expect(parseShellRecordRead(p)).toMatchObject({ status: 'error', reason: 'not_ready_persistent', notReady: { persistent: true } })
		expect(storageReasonOf(p)).toBe('native_not_ready_final')
	})
	it('a persistent answer for g1_uninitialized (retryable true) is still persistent: explicit, not bounded', () => {
		const p = ack({ code: 'error', sub: 'not_ready_persistent', notReadyReason: 'g1_uninitialized', retryable: true })
		expect(storageReasonOf(p)).toBe('native_not_ready_final')
	})
})

describe('superseded envelope forms (v159/v160 SRR-*, UNR-*) are not valid not_ready answers', () => {
	it('SRR-02 envelope ok:false error not_ready with retryable true (v168 compatibility): bounded, never endless', () => {
		const p = { type: 'ack', ok: false, error: 'not_ready', notReadyReason: 'g1_uninitialized', retryable: true }
		expect(storageReasonOf(p)).toBe('native_not_ready_bounded')
	})
	it('SRR-01 envelope not_ready with retryable false: explicit at once', () => {
		expect(storageReasonOf({ type: 'ack', ok: false, error: 'not_ready', notReadyReason: 'storage_locked', retryable: false })).toBe('native_not_ready_final')
	})
	it('an envelope not_ready without retryable (v168): bounded, then the terminal (the re-reads end in native_not_ready_final)', () => {
		expect(storageReasonOf({ type: 'ack', ok: false, error: 'not_ready' })).toBe('native_not_ready_bounded')
	})
	it('UNR-01 envelope unreadable, retryable false (entitlement): explicit at once', () => {
		const p = { type: 'ack', ok: false, error: 'not_ready', notReadyReason: 'unreadable', unreadableCause: 'entitlement', retryable: false }
		expect(storageReasonOf(p)).toBe('native_not_ready_final')
	})
})

describe('the other answer shapes are unchanged', () => {
	it('SHAPE-01 absent is absent (ok:true, result.code absent)', () => {
		expect(parseShellRecordRead(ack({ code: 'absent' }))).toEqual({ status: 'absent' })
	})
	it('SHAPE-03 migrating stays a retry (native_retry)', () => {
		expect(storageReasonOf(ack({ code: 'migrating' }))).toBe('native_retry')
	})
	it('SHAPE-09 record_unreadable keeps its own reading wait', () => {
		expect(storageReasonOf(ack({ code: 'error', sub: 'record_unreadable' }))).toBe('native_reading')
	})
	it('SHAPE-10 origin_refused (envelope ok:false) is the update prompt, never a page entry', () => {
		expect(storageReasonOf({ type: 'ack', ok: false, error: 'origin_refused' })).toBe('app_update_required')
	})
	it('SHAPE-11 bad_request (envelope ok:false) is an explicit record error', () => {
		expect(storageReasonOf({ type: 'ack', ok: false, error: 'bad_request' })).toBe('native_record')
	})
})

describe('the ceiling rules', () => {
	it('the bounded ladder is 0.5, 1, 2, 4, 8 seconds (five re-reads)', () => {
		expect([...NOT_READY_BOUNDED_DELAYS_MS]).toEqual([500, 1000, 2000, 4000, 8000])
	})
	it('the class: persistent first, then retryable true (bounded), otherwise zero', () => {
		expect(notReadyClass({ persistent: true, retryable: true })).toBe('persistent')
		expect(notReadyClass({ persistent: false, retryable: true })).toBe('bounded')
		expect(notReadyClass({ persistent: false, retryable: false })).toBe('zero')
		expect(notReadyClass({ persistent: false, retryable: undefined })).toBe('zero')
	})
	it('while a not_ready hold is set the App schedules no re-read; the hold is released by an answered read', () => {
		resetShellTerminalState()
		setShellReadHold('bounded')
		expect(emptyReadAction()).toBe('skip_terminal')
		setShellReadHold('final')
		expect(emptyReadAction()).toBe('skip_terminal')
		setShellReadHold('none')
		expect(emptyReadAction()).toBe('schedule')
	})
})

describe('static: the gate uses the ceiling ladder and the explicit final screen', () => {
	const gate = require('fs').readFileSync(require('path').join(__dirname, '..', 'components', 'AppEntryGate.tsx'), 'utf8') as string
	it('the bounded reason re-reads through NOT_READY_BOUNDED_DELAYS_MS, then shows the final reason; the final reason shows at once', () => {
		expect(gate).toContain("if (reason === 'native_not_ready_bounded') {")
		expect(gate).toContain('NOT_READY_BOUNDED_DELAYS_MS[attempt]')
		expect(gate).toContain("showStorageUnavailable('native_not_ready_final')")
		expect(gate).toContain("if (reason === 'native_not_ready_final') {")
	})
})

describe('static: the read hold follows each answered read (independent review, section 4)', () => {
	const beamioSrc = require('fs').readFileSync(require('path').join(__dirname, 'beamio.ts'), 'utf8') as string
	it('the catch sets the hold from the answer: a not_ready keeps its ceiling; any other answered reply releases it', () => {
		expect(beamioSrc).toContain("setShellReadHold(readReason === 'native_not_ready_bounded' ? 'bounded' : readReason === 'native_not_ready_final' ? 'final' : 'none')")
		expect(beamioSrc).toContain("if (read.status === 'ok' || read.status === 'absent') setShellReadHold('none')")
	})
})

describe('v168 §188.2 legacy envelope: the reason decides when retryable is absent', () => {
	it('notReadyReason storage_locked without retryable: zero (explicit at once)', () => {
		expect(storageReasonOf({ type: 'ack', ok: false, error: 'not_ready', notReadyReason: 'storage_locked' })).toBe('native_not_ready_final')
	})
	it('notReadyReason ambiguous_accounts without retryable: zero', () => {
		expect(storageReasonOf({ type: 'ack', ok: false, error: 'not_ready', notReadyReason: 'ambiguous_accounts' })).toBe('native_not_ready_final')
	})
	it('notReadyReason g1_uninitialized without retryable: bounded', () => {
		expect(storageReasonOf({ type: 'ack', ok: false, error: 'not_ready', notReadyReason: 'g1_uninitialized' })).toBe('native_not_ready_bounded')
	})
	it('retryable present wins over the reason', () => {
		expect(storageReasonOf({ type: 'ack', ok: false, error: 'not_ready', notReadyReason: 'storage_locked', retryable: true })).toBe('native_not_ready_bounded')
	})
})


describe('the superseded persistent envelope keeps its reason for the diagnostic (v168 §188.2)', () => {
	it('ok:false error not_ready_persistent with notReadyReason: the terminal, and notReadyReason is kept', () => {
		const p = { type: 'ack', ok: false, error: 'not_ready_persistent', notReadyReason: 'storage_locked', retryable: false }
		expect(parseShellRecordRead(p)).toMatchObject({ status: 'error', reason: 'not_ready_persistent', notReady: { notReadyReason: 'storage_locked', persistent: true } })
		expect(storageReasonOf(p)).toBe('native_not_ready_final')
	})
})

describe('v171 §191: a snapshot-unknown not_ready reuses g1_uninitialized (retryable true); no snapshot_unknown code', () => {
	it('ok:true not_ready g1_uninitialized retryable true: bounded (five re-reads, then explicit)', () => {
		expect(storageReasonOf(ack({ code: 'not_ready', notReadyReason: 'g1_uninitialized', retryable: true }))).toBe('native_not_ready_bounded')
	})
	it('snapshot_unknown is not a printable code (withdrawn by v171)', () => {
		expect(diagnosticCode('snapshot_unknown')).toBe('other')
	})
})

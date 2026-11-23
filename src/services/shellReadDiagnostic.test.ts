/**
 * The shellRecordRead diagnostic carries the classification (notReadyReason, retryable, unreadableCause) and never a value (2026-11-21).
 */
import { parseShellRecordRead, shellReadDiagnosticFields } from './shellRecordStore'
import { shellStorageErrorReason } from './shellStoreWait'

describe('shellReadDiagnosticFields', () => {
	it('prints notReadyReason=unreadable with retryable from an iOS not_ready answer (the empty-install case)', () => {
		const payload = { type: 'ack', ok: true, result: { code: 'error', sub: 'not_ready', notReadyReason: 'unreadable', retryable: true } }
		expect(shellReadDiagnosticFields(payload)).toBe(' envelope=ok,result,type resultCode=error notReadyReason=unreadable retryable=true')
	})
	it('prints unreadableCause as a category when present', () => {
		const payload = { type: 'ack', ok: true, result: { code: 'error', sub: 'unreadable', retryable: false, unreadableCause: 'entitlement' } }
		expect(shellReadDiagnosticFields(payload)).toBe(' envelope=ok,result,type resultCode=error retryable=false unreadableCause=entitlement')
	})
	it('a value that is not a short lower-case code is logged as other, never the value', () => {
		const payload = { type: 'ack', ok: true, result: { code: 'error', notReadyReason: '0xSECRET phrase here', unreadableCause: 'Has Upper' } }
		const out = shellReadDiagnosticFields(payload)
		expect(out).toBe(' envelope=ok,result,type resultCode=error notReadyReason=other unreadableCause=other')
		expect(out).not.toContain('SECRET')
		expect(out).not.toContain('phrase')
	})
	it('an absent or plain answer adds nothing', () => {
		expect(shellReadDiagnosticFields(null)).toBe('')
		expect(shellReadDiagnosticFields({ type: 'ack', ok: true, result: { code: 'absent' } })).toBe(' envelope=ok,result,type resultCode=absent')
	})
})

describe('answer shape and not_ready mapping (v162 §182: not_ready is a result code under ok:true)', () => {
	it('an ok:true absent answer logs the envelope names and resultCode=absent, and parses as absent', () => {
		const payload = { type: 'ack', ok: true, result: { code: 'absent' } }
		expect(shellReadDiagnosticFields(payload)).toBe(' envelope=ok,result,type resultCode=absent')
		expect(parseShellRecordRead(payload)).toEqual({ status: 'absent' })
	})
	it('an ok:true not_ready result code is a retryable not_ready (native_retry), not an envelope error', () => {
		const payload = { type: 'ack', ok: true, result: { code: 'not_ready' } }
		expect(parseShellRecordRead(payload)).toMatchObject({ status: 'error', reason: 'not_ready', notReady: { retryable: undefined, persistent: false } })
		expect(shellStorageErrorReason('shell_record_not_ready')).toBe('native_retry')
	})
	it('an ok:true not_ready_persistent is never auto-retried: it is not native_retry', () => {
		const payload = { type: 'ack', ok: true, result: { code: 'not_ready_persistent' } }
		expect(parseShellRecordRead(payload)).toEqual({ status: 'error', reason: 'not_ready_persistent' })
		expect(shellStorageErrorReason('shell_record_not_ready_persistent')).not.toBe('native_retry')
	})
	it('a status-only answer (no ok, no result) is unrecognised: the diagnostic names its keys and the read is an error, never absent', () => {
		const payload = { type: 'ack', status: 'absent' }
		expect(shellReadDiagnosticFields(payload)).toContain('envelope=status,type')
		expect(parseShellRecordRead(payload)).toEqual({ status: 'error', reason: 'native_unavailable' })
	})
})

describe('diagnostic codes: a whitelist, never a free text or a mnemonic word (f828dace review, 2026-11-21)', () => {
	it('a BIP-39 word in notReadyReason or resultCode is printed as other, not as itself', () => {
		const payload = { type: 'ack', ok: true, result: { code: 'abandon', notReadyReason: 'abandon', unreadableCause: 'legal' } }
		const out = shellReadDiagnosticFields(payload)
		expect(out).toContain('resultCode=other')
		expect(out).toContain('notReadyReason=other')
		expect(out).toContain('unreadableCause=other')
		expect(out).not.toContain('abandon')
		expect(out).not.toContain('legal')
	})
	it('a listed code is printed as itself', () => {
		const payload = { type: 'ack', ok: true, result: { code: 'not_ready', notReadyReason: 'g1_uninitialized', unreadableCause: 'device_locked' } }
		const out = shellReadDiagnosticFields(payload)
		expect(out).toContain('resultCode=not_ready')
		expect(out).toContain('notReadyReason=g1_uninitialized')
		expect(out).toContain('unreadableCause=device_locked')
	})
})

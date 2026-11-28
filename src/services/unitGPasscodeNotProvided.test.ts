/**
 * @jest-environment node
 *
 * Unit g (2026-11-22): passcode_not_provided is an explicit not_ready class. It is a background wait: never a screen, never a button,
 * never onboarding, never counted toward the bounded not_ready re-reads, never confirmed_missing, never native_record. Data is kept.
 * Synthetic values only; no phrase, key or ciphertext appears here.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { shellStorageErrorReason, isPasscodeNotProvidedAnswer, NOT_READY_BOUNDED_DELAYS_MS } from './shellStoreWait'
import { decidePageRecord, shellRecordReadState, type PageRecordRead } from './pageRecordDecision'
import { parseShellRecordRead, parseShellRecordWrite, shellRecordAsWalletRecord, writeFailureDisposition, isWriteRefusalCode } from './shellRecordStore'
import { nativeStartRoute } from './accountJudgement'
import { prereadFromAnswer } from './nativeRecovery'
import { shellNotReadyWaitReason } from './shellNotReadyWait'
import { passcodeNotProvidedEffect } from './shellStoreWait'
import { diagnosticCode, DIAGNOSTIC_CODES } from './diagnosticCodes'
import { START_REASON_CODES, isStartReasonCode } from './startReasonCodes'

const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const PASSCODE_REFUSED = { kind: 'refused' as const, code: 'passcode_not_provided' }
const LOADED: PageRecordRead = { status: 'loaded', data: { profiles: [{ keyID: EOA }], walletCredentialBlob: 'x' } }

describe('unit g: shellStorageErrorReason maps passcode_not_provided explicitly', () => {
	it('the shell error message maps to native_passcode_not_provided (not native_record, not native_retry)', () => {
		expect(shellStorageErrorReason('shell_record_passcode_not_provided')).toBe('native_passcode_not_provided')
		expect(shellStorageErrorReason('shell_record_passcode_not_provided')).not.toBe('native_record')
		expect(shellStorageErrorReason('shell_record_passcode_not_provided')).not.toBe('native_retry')
	})

	it('the bare native reason maps the same way (walletStatus and pwaWalletSync spellings)', () => {
		expect(shellStorageErrorReason('passcode_not_provided')).toBe('native_passcode_not_provided')
		expect(isPasscodeNotProvidedAnswer('shell_record_passcode_not_provided')).toBe(true)
		expect(isPasscodeNotProvidedAnswer('shell_record_passcode_not_provided_extra')).toBe(false)
	})

	it('it is not a not_ready ceiling: it never uses the bounded count or the final error', () => {
		const reason = shellStorageErrorReason('shell_record_passcode_not_provided')
		expect(reason).not.toBe('native_not_ready_bounded')
		expect(reason).not.toBe('native_not_ready_final')
		expect(NOT_READY_BOUNDED_DELAYS_MS.length).toBe(5)
	})

	it('other records keep their classes (no regression: needs_native_recovery and origin_refused)', () => {
		expect(shellStorageErrorReason('shell_record_needs_native_recovery')).toBe('native_recovery_needed')
		expect(shellStorageErrorReason('shell_record_origin_refused')).toBe('app_update_required')
	})
})

describe('unit g: the four answers map to passcode_not_provided', () => {
	it('shellRecordRead: a result code passcode_not_provided throws shell_record_passcode_not_provided', () => {
		const read = parseShellRecordRead({ type: 'ack', ok: true, result: { code: 'passcode_not_provided' } })
		expect(read.status).toBe('error')
		let msg = ''
		try {
			shellRecordAsWalletRecord(read)
		} catch (e) {
			msg = (e as Error).message
		}
		expect(msg).toBe('shell_record_passcode_not_provided')
		expect(shellStorageErrorReason(msg)).toBe('native_passcode_not_provided')
	})

	it('shellRecordWrite: a write answer with passcode_not_provided is an error carrying the same reason', () => {
		const write = parseShellRecordWrite({ type: 'ack', ok: true, result: { code: 'passcode_not_provided' } })
		expect(write).toMatchObject({ status: 'error', reason: 'passcode_not_provided' })
		expect(shellStorageErrorReason(`shell_record_${(write as { reason: string }).reason}`)).toBe('native_passcode_not_provided')
	})

	it('walletStatus not_ready is a shell wait, never an onboarding entry (no creation, no recovery)', () => {
		const wait = shellNotReadyWaitReason({ isShell: true, walletStatus: 'not_ready', presence: 'absent' })
		expect(wait).toEqual(expect.stringContaining('wait and retry'))
	})

	it('pwaWalletSync (ciphertext present, passcode not sent) maps through the same message', () => {
		expect(shellStorageErrorReason('shell_record_passcode_not_provided')).toBe('native_passcode_not_provided')
	})
})

describe('unit g: pageRecordDecision callers', () => {
	it('decidePageRecord: a passcode refusal is passcode_not_provided, not retry, not record_unavailable, not empty', () => {
		expect(decidePageRecord(LOADED, PASSCODE_REFUSED, EOA)).toBe('passcode_not_provided')
		expect(decidePageRecord({ status: 'empty' }, PASSCODE_REFUSED, EOA)).toBe('passcode_not_provided')
	})

	it('shellRecordReadState: the reason is native_passcode_not_provided, never native_record (no error screen)', () => {
		const state = shellRecordReadState({ walletCredentialBlob: 'x' }, PASSCODE_REFUSED)
		expect(state).toEqual({ kind: 'unavailable', reason: 'native_passcode_not_provided' })
	})

	it('other refusals are unchanged: origin_refused stays native_record, not_trusted stays app_update_required', () => {
		expect(shellRecordReadState({}, { kind: 'refused', code: 'origin_refused' })).toEqual({ kind: 'unavailable', reason: 'native_record' })
		expect(shellRecordReadState({}, { kind: 'refused', code: 'not_trusted' })).toEqual({ kind: 'unavailable', reason: 'app_update_required' })
	})

	it('the AppEntryGate caller (restorePageCopy) answers retry for passcode_not_provided, never record_unavailable', () => {
		const gate = readFileSync(join(__dirname, '..', 'components', 'AppEntryGate.tsx'), 'utf8')
		const at = gate.indexOf("if (decision === 'passcode_not_provided') {")
		expect(at).toBeGreaterThan(0)
		const block = gate.slice(at, at + 400)
		expect(block).toContain("return 'retry'")
		expect(block).not.toContain("'record_unavailable'")
		expect(block).not.toContain('showStorageUnavailable')
	})
})

describe('unit g: AppEntryGate pending sync (rev: a native answer, never a landing decision)', () => {
	const gate = readFileSync(join(__dirname, '..', 'components', 'AppEntryGate.tsx'), 'utf8')

	it('the effect is pending sync only: no landing change, no screen, no button, no re-read, not counted', () => {
		expect(passcodeNotProvidedEffect()).toEqual({ landingChanged: false, pendingSync: true, rereads: 0, screen: 'none', button: false, counted: false })
	})

	it('the shell read answer marks pending sync and returns: no splash, no timer, no screen, no onboarding, no counter', () => {
		const at = gate.indexOf("if (reason === 'native_passcode_not_provided') {")
		expect(at).toBeGreaterThan(0)
		expect(at).toBeLessThan(gate.indexOf('if (nativeShell && !SHELL_SCREEN_REASONS.has(reason))'))
		expect(at).toBeLessThan(gate.indexOf("if (reason === 'native_not_ready_bounded') {"))
		const block = gate.slice(at, at + 200)
		expect(block).toContain("markPasscodePendingSync('shell read answer', 'passcode_not_provided')")
		expect(block).toContain('return')
		expect(block).not.toContain('setSplashVisible')
		expect(block).not.toContain('showStorageUnavailable')
		expect(block).not.toContain('startupWait')
		expect(block).not.toContain('window.setTimeout')
		expect(block).not.toContain('goOnboarding')
	})

	it('markPasscodePendingSync never touches splash, timers, retry offer or counters', () => {
		const body = gate.slice(gate.indexOf('const markPasscodePendingSync'), gate.indexOf('const showStorageUnavailable'))
		expect(body).toContain('passcodePendingSyncRef.current = true')
		expect(body).toContain('passcodeNotProvidedEffect()')
		expect(body).not.toContain('setSplashVisible')
		expect(body).not.toContain('setStartupRetryOffered')
		expect(body).not.toContain('setTimeout')
		expect(body).not.toContain('boundedNotReadyRef')
		expect(body).not.toContain('nativeRetryAttemptRef')
	})

	it('walletStatus not_ready with passcode_not_provided logs the native_passcode_not_provided diagnostic', () => {
		expect(gate).toContain("walletStatusAnswer.notReadyReason === 'passcode_not_provided'")
		expect(gate).toContain("markPasscodePendingSync('walletStatus not_ready (legacy)', 'native_passcode_not_provided')")
	})

	it('local valid mnemonic: the home is entered before any native read, so a native passcode answer cannot change it', () => {
		const home = gate.indexOf("if (first.kind === 'valid') {")
		const homeEnter = gate.indexOf('applyLocalWallet(first.eoa)', home)
		const preread = gate.indexOf('await readPrereadCapped(reqId)', home)
		const walletStatus = gate.indexOf('queryNativeWalletStatus', home)
		expect(home).toBeGreaterThan(0)
		expect(homeEnter).toBeGreaterThan(home)
		expect(homeEnter).toBeLessThan(preread)
		expect(homeEnter).toBeLessThan(walletStatus)
		const block = gate.slice(home, homeEnter)
		expect(block).not.toContain('handleStorageUnavailable')
		expect(block).not.toContain('passcode')
	})

	it('the page store read returns a valid mnemonic before the native shellRecordRead is asked (beamio.ts)', () => {
		const beamio = readFileSync(join(__dirname, 'beamio.ts'), 'utf8')
		const page = beamio.indexOf("if (page.status === 'unknown') {")
		const entered = beamio.indexOf("'[startup] page IndexedDB mnemonic valid: entered on the page record; native reads are not needed at start'")
		const native = beamio.indexOf('const nativeFirst = await shellNativeFirstRead(options)')
		expect(page).toBeGreaterThan(0)
		expect(entered).toBeGreaterThan(page)
		expect(entered).toBeLessThan(native)
	})
})

describe('unit g: write pending sync (not a failure, not an exhausted retry)', () => {
	it('writeFailureDisposition: passcode_not_provided is pending_sync, not refused, not not_ready, not retry', () => {
		expect(writeFailureDisposition('passcode_not_provided')).toBe('pending_sync')
		expect(isWriteRefusalCode('passcode_not_provided')).toBe(false)
		expect(writeFailureDisposition('shell_record_not_ready_bounded')).toBe('not_ready')
		expect(writeFailureDisposition('bad_request')).toBe('refused')
		expect(writeFailureDisposition('timeout')).toBe('retry')
	})
})

describe('unit g: diagnostic code', () => {
	it('passcode_not_provided is a listed diagnostic code and prints as itself, not native_record or other', () => {
		expect(DIAGNOSTIC_CODES.has('passcode_not_provided')).toBe(true)
		expect(diagnosticCode('passcode_not_provided')).toBe('passcode_not_provided')
		expect(diagnosticCode(('shell_record_passcode_not_provided' as string).replace(/^shell_record_/, ''))).toBe('passcode_not_provided')
		expect(diagnosticCode('native_record')).toBe('other')
	})

	it('native_passcode_not_provided is a listed diagnostic code (walletStatus path)', () => {
		expect(DIAGNOSTIC_CODES.has('native_passcode_not_provided')).toBe(true)
		expect(diagnosticCode('native_passcode_not_provided')).toBe('native_passcode_not_provided')
	})

	it('the start reason table lists passcode_not_provided with a fixed redacted token', () => {
		expect(isStartReasonCode('passcode_not_provided')).toBe(true)
		expect(START_REASON_CODES.passcode_not_provided).toMatch(/pending-sync/)
	})
})

describe('unit g rev 2 (pure): SRP v2 / v291 alignment', () => {
	it('a shellRecordRead answer not_ready + notReadyReason passcode_not_provided is passcode_not_provided, never a not_ready class', () => {
		const read = parseShellRecordRead({ type: 'ack', ok: true, result: { code: 'not_ready', notReadyReason: 'passcode_not_provided', retryable: false } })
		expect(read).toEqual({ status: 'error', reason: 'passcode_not_provided' })
		expect(shellStorageErrorReason('shell_record_passcode_not_provided')).toBe('native_passcode_not_provided')
	})

	it('a shellRecordWrite answer not_ready + passcode_not_provided is passcode_not_provided', () => {
		const write = parseShellRecordWrite({ type: 'ack', ok: true, result: { code: 'not_ready', notReadyReason: 'passcode_not_provided' } })
		expect(write).toEqual({ status: 'error', reason: 'passcode_not_provided' })
	})

	it('other not_ready reasons keep the not_ready class (no regression)', () => {
		const read = parseShellRecordRead({ type: 'ack', ok: true, result: { code: 'not_ready', notReadyReason: 'device_locked', retryable: true } })
		expect(read).toMatchObject({ status: 'error', reason: 'not_ready' })
	})

	it('a real read storage failure is record_unreadable (native_reading), never a generic unreadable alias', () => {
		const read = parseShellRecordRead({ type: 'ack', ok: true, result: { code: 'record_unreadable' } })
		expect(read).toEqual({ status: 'error', reason: 'record_unreadable' })
		expect(shellStorageErrorReason('shell_record_record_unreadable')).toBe('native_reading')
	})

	it('a real write storage failure is retried as a write failure, never pending sync and never a passcode state', () => {
		expect(writeFailureDisposition('write_failed')).toBe('retry')
		expect(writeFailureDisposition('passcode_not_provided')).toBe('pending_sync')
	})

	it('rule A: a passcode account never reaches onboarding, even when the pre-read answers absent', () => {
		const base = { pre: { kind: 'absent' }, walletState: 'absent' as const, hasKey: false as const, walletStatus: 'not_ready' }
		expect(nativeStartRoute({ ...base, passcodePending: true })).toEqual({ route: 'retry', reason: 'passcode_not_provided' })
		expect(nativeStartRoute({ ...base, walletStatus: 'no_key', passcodePending: true })).toEqual({ route: 'retry', reason: 'passcode_not_provided' })
		expect(nativeStartRoute({ ...base, hasKey: true, passcodePending: true })).toEqual({ route: 'retry', reason: 'key_marker' })
	})

	it('legacy B: without the passcode state a confirmed absent + no_key onboards; not_ready branches by notReadyReason; unknown pre or present record holds', () => {
		const base = { pre: { kind: 'absent' }, walletState: 'absent' as const, hasKey: false as const }
		expect(nativeStartRoute({ ...base, walletStatus: 'no_key' })).toEqual({ route: 'onboard', reason: 'confirmed_absent' })
		expect(nativeStartRoute({ ...base, walletStatus: 'not_ready' })).toEqual({ route: 'retry', reason: 'status_not_no_key' })
		expect(nativeStartRoute({ ...base, walletStatus: 'not_ready', notReadyReason: 'key_only' })).toEqual({
			route: 'local',
			reason: 'key_only',
		})
		expect(nativeStartRoute({ ...base, pre: { kind: 'unknown' }, walletStatus: 'not_ready' }).route).toBe('retry')
		expect(nativeStartRoute({ ...base, walletState: 'present' as const, walletStatus: 'not_ready' }).route).toBe('retry')
	})

	it('rule D (static): the storage-unavailable Retry and the old-shell terminal button are browser-only', () => {
		const gate = readFileSync(join(__dirname, '..', 'components', 'AppEntryGate.tsx'), 'utf8')
		const terminal = gate.slice(gate.indexOf("storageUnavailable === OLD_SHELL_UPGRADE_REASON ? ("), gate.indexOf("storageUnavailable === 'app_update_required' ? ("))
		expect(terminal).toContain('!(isShellContext() || nativeShellRef.current || isCashTreesNativeWebView()) && (')
		expect(gate).toContain('!(isShellContext() || nativeShellRef.current || isCashTreesNativeWebView()) && storageUnavailable !== OLD_SHELL_UPGRADE_REASON')
	})
})

describe('unit g rev 3: SRP v2 cases (pure mapping, synthetic)', () => {
	it('SRP-02: a write envelope not_ready with passcode_not_provided is passcode_not_provided, never write_failed', () => {
		const write = parseShellRecordWrite({ type: 'ack', ok: false, error: 'not_ready', notReadyReason: 'passcode_not_provided', retryable: true })
		expect(write).toEqual({ status: 'error', reason: 'passcode_not_provided' })
		expect(writeFailureDisposition('passcode_not_provided')).toBe('pending_sync')
	})

	it('SRP-03: a read storage fault (result error, sub record_unreadable) is record_unreadable -> native_reading, data kept', () => {
		const read = parseShellRecordRead({ type: 'ack', ok: true, result: { code: 'error', sub: 'record_unreadable' } })
		expect(read).toEqual({ status: 'error', reason: 'record_unreadable' })
		expect(shellStorageErrorReason('shell_record_record_unreadable')).toBe('native_reading')
	})

	it('SRP-04: a real write storage fault (envelope write_failed) is a write failure (retry), never passcode', () => {
		const write = parseShellRecordWrite({ type: 'ack', ok: false, error: 'write_failed' })
		expect(write).toEqual({ status: 'error', reason: 'write_failed' })
		expect(writeFailureDisposition('write_failed')).toBe('retry')
	})

	it('SRP-05: an unknown state is not_ready unreadable (bounded), not a new code', () => {
		const read = parseShellRecordRead({ type: 'ack', ok: true, result: { code: 'not_ready', notReadyReason: 'unreadable', retryable: true } })
		expect(read).toMatchObject({ status: 'error', reason: 'not_ready', notReady: { notReadyReason: 'unreadable' } })
		expect(shellStorageErrorReason('shell_record_not_ready_bounded')).toBe('native_not_ready_bounded')
	})
})

describe('unit g rev 4 (pure): nativeMnemonicPreread current record as is (PRR-01..05, PRR-07)', () => {
	const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
	const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
	const ack = (result: unknown) => ({ kind: 'payload', payload: { type: 'ack', ok: true, result } })

	it('PRR-01 plaintext current returned as is (ok, mnemonic): valid, derived EOA, no passcode', () => {
		expect(prereadFromAnswer(ack({ code: 'ok', mnemonic: PHRASE, eoa: EOA }))).toEqual({ kind: 'valid', eoa: EOA, phrase: PHRASE })
		// 0.53.47: an ok plaintext answer without eoa is valid on the derived address (the same address as with the eoa)
		expect(prereadFromAnswer(ack({ code: 'ok', mnemonic: PHRASE }))).toEqual({ kind: 'valid', eoa: EOA, phrase: PHRASE })
	})

	it('PRR-02 ciphertext current returned without a passcode (ok, cipher): the has answer, plaintext not returned', () => {
		expect(prereadFromAnswer(ack({ code: 'ok', cipher: { v: 3, mode: 'passcode' } }))).toEqual({ kind: 'cipher', cipher: { v: 3, mode: 'passcode' } })
	})

	it('PRR-03 empty: confirmed_missing is the only absent', () => {
		expect(prereadFromAnswer(ack({ code: 'confirmed_missing' }))).toEqual({ kind: 'absent' })
	})

	it('PRR-04 read failure: read_error is unknown, never absent', () => {
		expect(prereadFromAnswer(ack({ code: 'read_error' }))).toEqual({ kind: 'unknown', reason: 'read_error' })
	})

	it('PRR-05 a string cipher is unknown (retryable): never valid, never absent (6)', () => {
		expect(prereadFromAnswer(ack({ code: 'ok', cipher: 'v3-synthetic-envelope' }))).toEqual({ kind: 'unknown' })
	})

	it('PRR-07 the passcode state of other commands does not change the preread answer', () => {
		expect(prereadFromAnswer(ack({ code: 'ok', cipher: { v: 3, mode: 'passcode' } }))).toEqual({ kind: 'cipher', cipher: { v: 3, mode: 'passcode' } })
		expect(prereadFromAnswer(ack({ code: 'not_ready', notReadyReason: 'passcode_not_provided' }))).toEqual({ kind: 'unknown', reason: 'not_ready' })
	})

	it('the ciphertext route is the unlock page and is not held by walletStatus passcode state', () => {
		const base = { pre: { kind: 'cipher', cipher: { v: 3 } }, walletState: 'not_reported' as const, hasKey: 'not_reported' as const, walletStatus: 'not_ready', passcodePending: true }
		expect(nativeStartRoute(base)).toEqual({ route: 'native_locked', reason: 'native_locked' })
	})
})

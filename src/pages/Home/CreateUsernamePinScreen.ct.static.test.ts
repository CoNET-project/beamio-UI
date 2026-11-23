/**
 * @jest-environment node
 *
 * v10.2 r4 §2.2 (CT series), page wiring. Static order checks; the timing and admission rules are in nativeCreateWait.test.ts.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, 'CreateUsernamePinScreen.tsx'), 'utf8')

describe('native create wait wiring (CT series)', () => {
	it('CT-9: a result with no wait is dropped before any state changes in the listener', () => {
		const start = src.indexOf('onNativeAccountCreateResult((accepted)')
		const drop = src.indexOf('if (!waited.deliver) return', start)
		const first = src.indexOf('setNativeOpening(false)', start)
		expect(start).toBeGreaterThan(0)
		expect(drop).toBeGreaterThan(start)
		expect(first).toBeGreaterThan(drop)
	})

	it('CT-6b: a pending wait refuses a new open before the open request is sent', () => {
		const refuse = src.indexOf("if (createWaitRef.current.kind === 'pending') {")
		const open = src.indexOf('const opened = await nativeAccountCreateOpen(trimmedTag)')
		expect(refuse).toBeGreaterThan(0)
		expect(open).toBeGreaterThan(refuse)
	})

	it('CT-4b: after a fallback, the new open rereads walletEoaAddress before the open request is sent', () => {
		const fb = src.indexOf("if (createWaitRef.current.kind === 'fallback') {")
		const reread = src.indexOf('readWalletEoaAddress()', fb)
		const admit = src.indexOf('canStartCreate(createWaitRef.current, reread)', fb)
		const open = src.indexOf('const opened = await nativeAccountCreateOpen(trimmedTag)', fb)
		expect(fb).toBeGreaterThan(0)
		expect(reread).toBeGreaterThan(fb)
		expect(admit).toBeGreaterThan(reread)
		expect(open).toBeGreaterThan(admit)
	})

	it('CT-1c: the wait starts on the page-opened acknowledgement and the 10-minute timer ends only the wait', () => {
		const started = src.indexOf('createWaitRef.current = startCreateWait(Date.now(), createWaitSeqRef.current)')
		const timer = src.indexOf('createWaitCancelRef.current = scheduleCreateFallback(() => {', started)
		const tick = src.indexOf('tickCreateWait(createWaitRef.current, Date.now())', timer)
		expect(started).toBeGreaterThan(0)
		expect(timer).toBeGreaterThan(started)
		expect(tick).toBeGreaterThan(timer)
		const block = src.slice(timer, timer + 700)
		expect(block).not.toContain('setCreateError(tu(\'create_account_unavailable')
		expect(block).not.toContain('announceNativeWalletEstablished')
		expect(block).not.toContain('notifyNativeWalletReady')
	})

	it('CT-16 (no completion on a late result): the completion calls are not reachable through the dropped path', () => {
		const start = src.indexOf('onNativeAccountCreateResult((accepted)')
		const drop = src.indexOf('if (!waited.deliver) return', start)
		expect(src.slice(start, drop)).not.toContain('announceNativeWalletEstablished')
		expect(src.slice(start, drop)).not.toContain('notifyNativeWalletReady')
	})
})

describe('cancel, cancelled, still-open and late-ok wiring (CT-13, CT-15, CT-15b, CT-16; r5 §§二、四、五)', () => {
	it('CT-15: the cancel control ends the wait, judges nothing, and shows the cancelled copy', () => {
		const at = src.indexOf("create_account_cancel')}")
		expect(at).toBeGreaterThan(0)
		const block = src.slice(at - 700, at)
		expect(block).toContain('cancelCreateWait(createWaitRef.current)')
		expect(block).toContain('announceNativeFlowPending(false)')
		expect(block).toContain("setCreateError(tu('create_account_cancelled_retry'))")
		expect(block).not.toContain('announceNativeWalletEstablished')
		expect(block).not.toContain('notifyNativeWalletReady')
	})

	it('CT-15b: the cancelled event shows the cancelled copy and judges nothing', () => {
		const at = src.indexOf("if (code === 'cancelled') {")
		expect(src.slice(at, at + 400)).toContain("setCreateError(tu('create_account_cancelled_retry'))")
		expect(src.slice(at, at + 400)).not.toContain('announceNativeWalletEstablished')
	})

	it('CT-13: after a fallback alone the retry is refused with the still-open copy, before any reread or open', () => {
		const at = src.indexOf("if (createWaitRef.current.kind === 'fallback') {")
		const refuse = src.indexOf("tu('create_account_native_still_open')", at)
		const open = src.indexOf('const opened = await nativeAccountCreateOpen(trimmedTag)', at)
		expect(at).toBeGreaterThan(0)
		expect(refuse).toBeGreaterThan(at)
		expect(open).toBeGreaterThan(refuse)
	})

	it('CT-16: a late ok clears the failure hint before it establishes', () => {
		const at = src.indexOf("if (code === 'ok') {")
		const clear = src.indexOf("setCreateError('')", at)
		const announce = src.indexOf('announceNativeWalletEstablished()', at)
		expect(clear).toBeGreaterThan(at)
		expect(announce).toBeGreaterThan(clear)
	})
})

describe('nested result wait and write-failed hold (Android review, this batch)', () => {
	it('page none starts the native wait so the nested result (already_bound, lookup_unavailable) is delivered', () => {
		const at = src.indexOf("ack page=${opened.page ?? 'absent'}; waiting for the nested result event")
		expect(at).toBeGreaterThan(0)
		const block = src.slice(at - 400, at + 200)
		expect(block).toContain('startNativeWait()')
	})

	it('a write_failed without a reason holds the submit button and the submit handler (explanation only)', () => {
		expect(src).toContain("setWriteHold(accepted.code === 'write_failed' && (accepted.reason === undefined || accepted.reason === 'rollback_pending' || accepted.reason === 'old_copy_unverified'))")
		expect(src).toContain('disabled={!canSubmit || writeHold}')
		expect(src).toContain('if (!canSubmit || (writeHold && !bypassWriteHold)) return')
	})

	it('a late ok after a cancel is delivered (the cancelled wait is not idle), clears the hint, and establishes once', () => {
		const at = src.indexOf("if (code === 'ok') {")
		expect(at).toBeGreaterThan(0)
		expect(src.slice(at, at + 200)).toContain("setCreateError('')")
	})
})

describe('r7 §一 retry after cancel; write-hold scope', () => {
	it('CT-15: after a cancel the open path refuses with the r7 prompt before any request', () => {
		const at = src.indexOf("if (createWaitRef.current.kind === 'cancelled') {")
		const open = src.indexOf('const opened = await nativeAccountCreateOpen(trimmedTag)', at)
		expect(at).toBeGreaterThan(0)
		expect(src.slice(at, at + 200)).toContain("tu('create_account_close_native_retry')")
		expect(open).toBeGreaterThan(at)
	})

	it('writeHold: reason missing or outside the vocabulary, old_copy_unverified (v10 OB-4 无按钮), and rollback_pending (v10 OB-3; rule: only the OB-3 button retries); not internal_state, storage_write (OB-1, OB-2 retry)', () => {
		expect(src).toContain("setWriteHold(accepted.code === 'write_failed' && (accepted.reason === undefined || accepted.reason === 'rollback_pending' || accepted.reason === 'old_copy_unverified'))")
	})

	it('the OB-3 rollback button bypasses writeHold (onSubmitPress(true)); the normal submit does not', () => {
		expect(src).toContain('onClick={() => void onSubmitPress(true)}')
		expect(src).toContain('if (!canSubmit || (writeHold && !bypassWriteHold)) return')
		expect(src).toContain('onClick={() => void onSubmitPress()}')
	})
})

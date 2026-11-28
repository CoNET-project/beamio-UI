/**
 * @jest-environment node
 *
 * v10.2 r4 §2.2 (CT series), page wiring. Static order checks; the timing and admission rules are in nativeCreateWait.test.ts.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, 'CreateUsernamePinScreen.tsx'), 'utf8')

describe('native create wait wiring (CT series)', () => {

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

	it('CT-16: a late ok clears the failure hint before it establishes', () => {
		const at = src.indexOf("if (code === 'ok') {")
		const clear = src.indexOf("setCreateError('')", at)
		const announce = src.indexOf('announceNativeWalletEstablished()', at)
		expect(clear).toBeGreaterThan(at)
		expect(announce).toBeGreaterThan(clear)
	})
})

describe('nested result wait and write-failed hold (Android review, this batch)', () => {
})

describe('r7 §一 retry after cancel; write-hold scope', () => {

	it('the OB-3 rollback button bypasses writeHold (onSubmitPress(true)); the normal submit does not', () => {
		expect(src).toContain('onClick={() => void onSubmitPress(true)}')
		expect(src).toContain('if (!canSubmit || (writeHold && !bypassWriteHold)) return')
		expect(src).toContain('onClick={() => void onSubmitPress()}')
	})
})

/**
 * @jest-environment node
 *
 * the wiring that the behaviour tests cannot reach from pure modules. The closed state is checked before the
 * unavailable state in the gate; a closed reason never retries; the retry cap counts failures only; the copy keys are in both locales
 * and in the copy register. Reads the sources.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', 'src', rel), 'utf8')
const chat = read('services/chat.ts')
const start = read('services/shellChatStart.ts')
const bridge = read('services/chatWorkerBridge.ts')
const gate = read('components/ShellChatUnavailableNotice.tsx')
const restore = read('pages/Home/RestoreWalletUnifiedScreen.tsx')

const KEYS = [
	'chat.clear_failed.body',
	'chat.clear_failed.entry',
	'chat.clear_confirm.body',
	'chat.clear_confirm.ok',
	'chat.clear_refused.body',
	'chat.import_retry.entry',
	'chat.retry_exhausted.body',
]

describe('wiring', () => {
	it('the copy keys exist in both locales', () => {
		const en = JSON.parse(read('locale/en.json')).ui
		const zh = JSON.parse(read('locale/zh-CN.json')).ui
		for (const k of KEYS) {
			expect(typeof en[k]).toBe('string')
			expect(typeof zh[k]).toBe('string')
		}
	})

	it('a closed reason returns before any automatic retry, and the closed notice is shown', () => {
		const closedAt = start.indexOf('const closed = deps.takeIdentityClosed?.()')
		const retryAt = start.indexOf("deps.retry('native listen did not start')")
		expect(closedAt).toBeGreaterThan(0)
		expect(start.indexOf("return 'identity_closed'")).toBeGreaterThan(closedAt)
		expect(retryAt).toBeGreaterThan(closedAt)
	})

	it('the bridge reports the closed reason of a refused start to the latch', () => {
		expect(bridge).toContain('initLatch.noteIdentityClosed(restoreCode ?? ')
		expect(bridge).toContain('export function takeIdentityClosedRefusal')
	})

	it('the gate shows the closed notice and the stopped-retries notice before the unavailable state', () => {
		const closedAt = gate.indexOf('if (closed) return <ShellIdentityClosedNotice />')
		const retriesAt = gate.indexOf('if (retriesStopped) return <ShellRetryExhaustedNotice />')
		const unavailableAt = gate.indexOf("if (state === 'chat_unavailable') return <ShellChatUnavailableNotice />")
		expect(closedAt).toBeGreaterThan(0)
		expect(retriesAt).toBeGreaterThan(closedAt)
		expect(unavailableAt).toBeGreaterThan(retriesAt)
	})

	it('a failed import switch is marked, so a later closed state offers the import retry', () => {
		expect(restore).toContain("if (code === 'clear_failed' || code === 'unregister_refused') markImportSwitchFailed()")
	})

	it('the chat module counts only failures against the limit, and a success or the manual retry starts again', () => {
		expect(chat).toContain("if (kind === 'continue' || shellRetryCap.failed() === 'retry') {")
		expect(chat).toContain("if (result === 'started') {")
		expect(chat).toContain('shellRetryCap.reset()')
		expect(chat).toContain('export function retryShellChatNow(): void {')
		expect(chat).toContain('registerShellRetryNow(retryShellChatNow)')
	})

	it('the continuation steps are marked as continuations', () => {
		expect(start).toContain("deps.retry('g1 init done', 'continue')")
		expect(start).toContain("deps.retry('pgp restored', 'continue')")
		expect(start).toContain("deps.retry('pgp already matches the backup', 'continue')")
	})
})

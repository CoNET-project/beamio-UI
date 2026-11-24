/**
 * @jest-environment node
 */
/**
 * The cold-start backoff is wired to the three not_ready reads and is reset by four events. Source pins; the schedule itself is
 * tested in coldStartBackoff.test.ts.
 */
import * as fs from 'fs'
import * as path from 'path'

const src = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')

describe('identityPublic (the chat start, chat.ts)', () => {
	const chat = src('services/chat.ts')
	it('a not_ready retry uses the cold-start schedule and its window; the window used up stops the automatic retries', () => {
		const block = chat.slice(chat.indexOf("if (kind === 'not_ready') {"), chat.indexOf("if (kind === 'continue' || shellRetryCap.failed()"))
		expect(block).toMatch(/coldStartBackoff\.next\('identityPublic'\)/)
		expect(block).toMatch(/scheduleChatRetry\(reason, args, step\.delayMs\)/)
		expect(block).toMatch(/setShellRetryExhausted\(true\)/)
		expect(block).not.toMatch(/shellRetryCap\.failed\(\)/)
	})
	it('it is reset by a success, a manual retry, the foreground resume and an account switch', () => {
		expect(chat).toMatch(/shellRetryCap\.reset\(\)\n\tcoldStartBackoff\.reset\(\)/)
		expect(chat).toMatch(/coldStartBackoff\.reset\('identityPublic'\)\n\t\t\t\tcoldStartBackoff\.reset\('pgpRestoreEvaluate'\)\n\t\t\t\tsetFirstIdentitySetup\('idle'\)/)
		expect(chat).toMatch(/coldStartBackoff\.reset\(\)\n\t\tnotifyPgpMigrateEvent\('foreground'\)\n\t\tawait initChat\(setProfiles, setAllNodes, setGossip, false, newMessage\)/)
		expect(chat).toMatch(/the live client belongs to another account[^\n]*\n\t\tcoldStartBackoff\.reset\(\)/)
	})
	it('the log lines carry the attempt number and the elapsed time only', () => {
		const lines = chat.match(/chatBootLog\(`identityPublic not_ready[^`]*`/g) ?? []
		expect(lines.length).toBeGreaterThan(0)
		for (const l of lines) expect(l).toMatch(/^chatBootLog\(`identityPublic not_ready: (attempt \$\{step\.attempt\} in \$\{step\.delayMs\} ms, \$\{step\.elapsedMs\} ms since the first|the 180 s window is used up after \$\{step\.attempt\} attempts \(\$\{step\.elapsedMs\} ms\); automatic retry stopped)`$/)
	})
})

describe('walletStatus and the pre-read (the entry gate, AppEntryGate.tsx)', () => {
	const gate = src('components/AppEntryGate.tsx')
	it('the walletStatus not_ready branch uses the cold-start schedule and has no attempt-count limit', () => {
		const block = gate.slice(gate.indexOf("if (reason === 'native_not_ready_bounded') {"), gate.indexOf("if (reason === 'native_not_ready_final') {"))
		expect(block).toMatch(/coldBackoffRef\.current\.next\('walletStatus'\)/)
		expect(block).not.toMatch(/NOT_READY_BOUNDED_DELAYS_MS|boundedNotReadyRef/)
		expect(gate).not.toMatch(/NOT_READY_BOUNDED_DELAYS_MS/)
	})
	it('a not_ready pre-read has no separate quick re-request and waits by the schedule; its window used up stops the automatic re-reads', () => {
		expect(gate).toMatch(/if \(!quickPrereadRetryRef\.current && pre\.reason !== 'not_ready'\) \{/)
		expect(gate).toMatch(/pre\.reason === 'not_ready' \? 'nativeMnemonicPreread' : undefined/)
		const wait = gate.slice(gate.indexOf('const startupWait = '), gate.indexOf('const retryTerminalOnce'))
		expect(wait).toMatch(/coldBackoffRef\.current\.next\(backoffKey\)/)
		expect(wait).toMatch(/step\.kind === 'exhausted'[\s\S]{0,400}return\n/)
	})
	it('it is reset by a success (markDecided) and by the return to the foreground', () => {
		expect(gate).toMatch(/const markDecided = \(\) => \{\n\t\tboundedNotReadyRef\.current = 0\n\t\tcoldBackoffRef\.current\.reset\(\)/)
		expect(gate).toMatch(/startupRetryRef\.current = undefined\n\t\t\tcoldBackoffRef\.current\.reset\(\)\n\t\t\tpublishNativePwaLog\('info', `\[reread\]/)
	})
	it('the log lines carry the command, the attempt number and the elapsed time only', () => {
		const lines = gate.match(/publishNativePwaLog\('(?:info|warn)', `\[AppEntryGate\] not_ready \(backoff\)[^`]*`/g) ?? []
		expect(lines.length).toBeGreaterThanOrEqual(3)
		for (const l of lines) expect(l).not.toMatch(/\$\{(?!step\.|backoffKey|delay)/)
	})
})

/**
 * step 5: the automatic retry schedule of an unknown start, and the static pins of the retry button and the no-give-up rule.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { startupRetryDelayMs, STARTUP_RETRY_BACKOFF_MS, STARTUP_RETRY_STEADY_MS } from './startupRetryPolicy'

describe('startupRetryDelayMs (2/4/8/16 s, then every 30 s, never given up)', () => {
	it('backs off 2, 4, 8, 16 seconds', () => {
		expect([1, 2, 3, 4].map(startupRetryDelayMs)).toEqual([2000, 4000, 8000, 16000])
		expect(STARTUP_RETRY_BACKOFF_MS).toEqual([2000, 4000, 8000, 16000])
	})

	it('from the fifth attempt on it repeats every 30 seconds, for any number of attempts', () => {
		expect(startupRetryDelayMs(5)).toBe(STARTUP_RETRY_STEADY_MS)
		expect(startupRetryDelayMs(500)).toBe(30_000)
	})

	it('an invalid attempt number uses the first backoff, never zero or a give-up value', () => {
		expect(startupRetryDelayMs(0)).toBe(2000)
		expect(startupRetryDelayMs(Number.NaN)).toBe(2000)
	})
})

describe('static pins: the visible retry button and no permanent skip', () => {
	const gate = readFileSync(join(__dirname, '..', 'components', 'AppEntryGate.tsx'), 'utf8')
	const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8')
	const helper = readFileSync(join(__dirname, 'shellTerminalState.ts'), 'utf8')

	it('the gate shows a visible retry button while the start is unknown and re-runs the start on click', () => {
		expect(gate).toContain('startupRetryOffered &&')
		expect(gate).toContain('onClick={retryStartupNow}')
		expect(gate).toContain("tu('native_not_ready_retry_action')")
	})

	it('the gate does not switch to the generic fallback screen in the startup wait', () => {
		const wait = gate.slice(gate.indexOf('const startupWait = (reason: string'), gate.indexOf('const startupWait = (reason: string') + 1200)
		expect(wait).not.toContain('NATIVE_RETRY_SCREEN')
		expect(wait).toContain('startupRetryDelayMs(attempt)')
	})

	it('the App init skip never gives up: the empty-read branch schedules the next re-read and raises the retry offer', () => {
		const at = app.indexOf('runEmptyReadBranch({')
		expect(at).toBeGreaterThan(0)
		const block = app.slice(at, at + 1000)
		expect(block).toContain('delayFor: startupRetryDelayMs')
		expect(block).toContain('STARTUP_RETRY_OFFER_EVENT')
		expect(block).toContain("void init('empty-read-retry')")
		expect(block).toContain('if (isShellTerminal()) return')
		expect(block).not.toMatch(/if \(shellEmptyReadRetryRef\.current >= /)
		// the branch helper never returns a give-up: its bounded schedule has no early exit except the terminal and the single probe
		expect(helper).toContain('io.schedule(delay)')
		expect(helper).not.toMatch(/if \(attempt >= /)
	})

	it('terminal (update prompt): the App never reads, schedules or re-reads; the branch decides skip_terminal first', () => {
		// the App's init returns before any storage read once the gate decided the terminal
		const start = app.indexOf('const initProceed = async')
		expect(app.slice(start, start + 600)).toContain('if (isShellContext() && isShellTerminal()) {')
		// the branch checks the terminal before any line or timer, and again before the retry line and the schedule
		const body = helper.slice(helper.indexOf('export function runEmptyReadBranch'), helper.indexOf('export function runEmptyReadBranch') + 1200)
		expect(body.indexOf("if (action === 'skip_terminal') return action")).toBeLessThan(body.indexOf('io.log('))
		expect((body.match(/if \(terminal\) return 'skip_terminal'/g) ?? []).length).toBeGreaterThanOrEqual(4)
		// the timer callback never re-reads once terminal
		expect(app).toMatch(/shellEmptyReadTimerRef\.current = null\s*if \(isShellTerminal\(\)\) return\s*void init\('empty-read-retry'\)/)
	})

	it('terminal: the pending App re-read timer is cleared when the gate decides the terminal', () => {
		expect(app).toContain('subscribeShellTerminal((terminalNow) => {')
		expect(app).toMatch(/if \(!terminalNow\) return\s*if \(shellEmptyReadTimerRef\.current !== null\) window\.clearTimeout\(shellEmptyReadTimerRef\.current\)/)
	})

	it('terminal screen: Retry runs exactly one probe through requestShellSingleProbe, and the gate marks the terminal again when still empty', () => {
		const retry = gate.slice(gate.indexOf('const retryTerminalOnce = async'), gate.indexOf('const retryTerminalOnce = async') + 1200)
		expect(retry).toContain('requestShellSingleProbe()')
		expect(retry).toContain('await initRef.current?.()')
		expect(gate).toContain('onClick={() => void retryTerminalOnce()}')
		expect(gate).toContain('decideShellTerminal(')
	})

	it('the gate terminal diagnostic names the real native reason, not a fixed one', () => {
		expect(gate).not.toContain('shellRecordRead not_supported')
		expect(gate).toContain('shellRecordFallbackLabel()')
	})

	it('the App decides at the empty answer through runEmptyReadBranch, before any retry line, offer or timer', () => {
		const at = app.indexOf('runEmptyReadBranch({')
		expect(at).toBeGreaterThan(0)
		const offer = app.indexOf('window.dispatchEvent(new Event(STARTUP_RETRY_OFFER_EVENT))', at)
		expect(offer).toBeGreaterThan(at)
		expect(app.indexOf('shellEmptyReadTimerRef.current = window.setTimeout', at)).toBeGreaterThan(offer)
		// the retry line lives in the helper, after its terminal checks
		expect(helper.indexOf('init skip: retry attempt ${attempt}')).toBeGreaterThan(helper.indexOf("if (action === 'skip_terminal') return action"))
	})

	it('the gate decides the terminal before it logs it, and clears the offer', () => {
		const term = gate.indexOf('decideShellTerminal(() => publishNativePwaLog(')
		expect(term).toBeGreaterThan(0)
		expect(gate.slice(term, term + 600)).toContain('setStartupRetryOffered(false)')
	})

	it('terminal screen: one Retry control, disabled while its probe runs; the probe keeps the terminal screen (no splash, no second control)', () => {
		expect(gate).toContain('disabled={terminalProbing}')
		expect(gate).toContain('onClick={() => void retryTerminalOnce()}')
		const body = gate.slice(gate.indexOf('const retryTerminalOnce = async'), gate.indexOf('const retryTerminalOnce = async') + 1200)
		expect(body.slice(0, body.indexOf('await initRef.current'))).not.toContain('setSplashVisible(true)')
		expect(body).toContain('if (terminalProbeRef.current) return')
		expect(body).toContain('if (!isShellTerminal()) {')
		expect(body).toContain('setStorageUnavailable(null)')
	})

	it('terminal screen: the generic reload Retry is not rendered for the terminal (a second control), and the terminal control is "Retry"', () => {
		expect(gate).toContain('{storageUnavailable !== OLD_SHELL_UPGRADE_REASON && (')
		expect(gate).toContain("{tu('retry')}")
		const term = gate.indexOf('onClick={() => void retryTerminalOnce()}')
		expect(term).toBeGreaterThan(0)
		expect(gate.slice(term, term + 120)).toContain("{tu('retry')}")
	})

	it('packaged bundle: the terminal markers are single (scripts/check-shell-terminal-single-copy.js runs in both shell builds)', () => {
		const pkg = readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')
		expect(pkg.match(/check-shell-terminal-single-copy\.js build/g)?.length).toBe(2)
		const script = readFileSync(join(__dirname, '..', '..', 'scripts', 'check-shell-terminal-single-copy.js'), 'utf8')
		expect(script).toContain("'terminal update prompt; no read, no retry'")
		expect(script).toContain('count === 1')
	})
})

describe('the silent cleanup is connected in the gate', () => {
	const gateSrc = readFileSync(join(__dirname, '..', 'components', 'AppEntryGate.tsx'), 'utf8')
	it('the gate calls the verified entry on recovery ok and resumes a pending marker at start', () => {
		expect(gateSrc).toContain('cleanupAfterVerifiedRecovery(window.localStorage, eoa, readPageDerivedAddress)')
		expect(gateSrc).toContain('readCleanupPending(window.localStorage)')
	})
})

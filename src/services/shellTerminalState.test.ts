/**
 * Terminal state of a fallback shell start (2026-11-21 review on S25 t168): once decided, no re-read is scheduled; only one probe
 * after the user's Retry runs, and a still-empty answer returns to the terminal.
 */
import {
	decideShellTerminal,
	runEmptyReadBranch,
	emptyReadAction,
	isShellTerminal,
	markShellTerminal,
	requestShellSingleProbe,
	resetShellTerminalState,
	subscribeShellTerminal,
	takeShellSingleProbe,
} from './shellTerminalState'
import { noteShellRecordFallback, shellRecordFallbackLabel } from './shellRecordFallback'

describe('shell terminal state', () => {
	beforeEach(() => resetShellTerminalState())

	it('starts not terminal, with no single probe pending', () => {
		expect(isShellTerminal()).toBe(false)
		expect(takeShellSingleProbe()).toBe(false)
	})

	it('after the terminal is decided, it stays terminal until the user Retry', () => {
		markShellTerminal()
		expect(isShellTerminal()).toBe(true)
		expect(isShellTerminal()).toBe(true)
	})

	it('Retry leaves the terminal and grants exactly one probe', () => {
		markShellTerminal()
		requestShellSingleProbe()
		expect(isShellTerminal()).toBe(false)
		expect(takeShellSingleProbe()).toBe(true)
		expect(takeShellSingleProbe()).toBe(false)
	})

	it('a still-empty probe returns to the terminal: the gate decides it again, and no probe stays pending', () => {
		markShellTerminal()
		requestShellSingleProbe()
		expect(takeShellSingleProbe()).toBe(true) // the App's empty read consumes the probe and schedules nothing
		markShellTerminal() // the gate's read is still empty
		expect(isShellTerminal()).toBe(true)
		expect(takeShellSingleProbe()).toBe(false)
	})

	it('deciding the terminal drops a pending probe', () => {
		requestShellSingleProbe()
		markShellTerminal()
		expect(takeShellSingleProbe()).toBe(false)
	})

	it('listeners hear each terminal change, so the App can cancel its pending re-read', () => {
		const seen: boolean[] = []
		const off = subscribeShellTerminal((t) => seen.push(t))
		markShellTerminal()
		requestShellSingleProbe()
		off()
		markShellTerminal()
		expect(seen).toEqual([true, false])
	})

	it('the diagnostic carries the native reason of the last fallback, or unrecorded', () => {
		expect(shellRecordFallbackLabel()).toBe('unrecorded')
		noteShellRecordFallback('unknown_command')
		expect(shellRecordFallbackLabel()).toBe('unknown_command')
		noteShellRecordFallback('not_supported')
		expect(shellRecordFallbackLabel()).toBe('not_supported')
	})

	it('a terminal decided while an init awaits its read schedules nothing (the race of S25 logcat line 86)', async () => {
		// the init passed its top guard (not terminal yet), then awaits the storage read; the gate decides the terminal during the await
		const decisions: string[] = []
		const initRun = async () => {
			await new Promise<void>((resolve) => setTimeout(resolve, 5))
			decisions.push(emptyReadAction())
		}
		const run = initRun()
		markShellTerminal()
		await run
		expect(decisions).toEqual(['skip_terminal'])
		expect(decisions).not.toContain('schedule')
	})

	it('no schedule is ever returned while terminal, whatever the number of empty reads', () => {
		markShellTerminal()
		for (let i = 0; i < 5; i++) expect(emptyReadAction()).toBe('skip_terminal')
	})

	it('after Retry: the single probe schedules nothing; if still empty the gate decides the terminal and nothing is scheduled', () => {
		markShellTerminal()
		requestShellSingleProbe()
		expect(emptyReadAction()).toBe('skip_single_probe')
		markShellTerminal() // the gate's probe result is still empty
		expect(emptyReadAction()).toBe('skip_terminal')
	})

	it('when not terminal and no probe is pending, an empty read schedules the normal re-read', () => {
		expect(emptyReadAction()).toBe('schedule')
	})
})

describe('the terminal is set before its diagnostic (S25 4023c85: the line came 1 ms before the state)', () => {
	beforeEach(() => resetShellTerminalState())

	it('inside the diagnostic, the terminal is already decided and an empty read returns skip_terminal', () => {
		let seenTerminal: boolean | null = null
		let decision: string | null = null
		decideShellTerminal(() => {
			seenTerminal = isShellTerminal()
			decision = emptyReadAction()
		})
		expect(seenTerminal).toBe(true)
		expect(decision).toBe('skip_terminal')
	})

	it('after the diagnostic, every empty read returns skip_terminal (never schedule)', () => {
		decideShellTerminal(() => undefined)
		for (let i = 0; i < 4; i++) expect(emptyReadAction()).toBe('skip_terminal')
	})

	it('an empty read that lands while the init awaits, after the terminal line, schedules nothing', async () => {
		const decisions: string[] = []
		const init = async () => {
			await new Promise<void>((resolve) => setTimeout(resolve, 5))
			decisions.push(emptyReadAction())
		}
		const run = init()
		decideShellTerminal(() => undefined)
		await run
		expect(decisions).toEqual(['skip_terminal'])
	})
})

describe('static: every terminal diagnostic in the gate sets the state first (decideShellTerminal)', () => {
	const gateSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'components', 'AppEntryGate.tsx'), 'utf8') as string
	it('no terminal log is printed without decideShellTerminal around it', () => {
		const logs = gateSrc.split('terminal: fallback shell (shellRecordRead').length - 1
		const wrapped = gateSrc.split('decideShellTerminal(() => publishNativePwaLog(').length - 1
		expect(logs).toBe(2)
		expect(wrapped).toBe(2)
	})
})

describe('runEmptyReadBranch: the App empty-read branch (the only emitter of "init skip: retry attempt")', () => {
	beforeEach(() => resetShellTerminalState())
	const io = () => {
		const calls: string[] = []
		const scheduled: number[] = []
		let attempts = 0
		return {
			calls,
			scheduled,
			attempts: () => attempts,
			nextAttempt: () => { attempts += 1; calls.push('nextAttempt'); return attempts },
			delayFor: (a: number) => (a === 1 ? 2000 : 4000),
			log: (line: string): void => { calls.push(line) },
			schedule: (ms: number): void => { scheduled.push(ms) },
		}
	}

	it('after the terminal is decided: no retry line, no schedule, no counter change, every time', () => {
		markShellTerminal()
		const x = io()
		for (let i = 0; i < 3; i++) expect(runEmptyReadBranch(x)).toBe('skip_terminal')
		expect(x.calls).toEqual([])
		expect(x.scheduled).toEqual([])
		expect(x.attempts()).toBe(0)
	})

	it('a terminal decided while the branch runs (during its first line) schedules nothing and prints no retry line', () => {
		const x = io()
		const log = x.log
		x.log = (line: string) => {
			log(line)
			markShellTerminal() // the gate decides the terminal in the middle of the branch
		}
		expect(runEmptyReadBranch(x)).toBe('skip_terminal')
		expect(x.calls.some((c) => c.includes('retry attempt'))).toBe(false)
		expect(x.scheduled).toEqual([])
	})

	it('not terminal: the normal bounded re-read is logged and scheduled once (2 s for attempt 1)', () => {
		const x = io()
		expect(runEmptyReadBranch(x)).toBe('schedule')
		expect(x.calls.filter((c) => c.includes('retry attempt 1, next in 2000 ms'))).toHaveLength(1)
		expect(x.scheduled).toEqual([2000])
	})

	it('a single probe after Retry that is still empty logs its own line and schedules nothing', () => {
		markShellTerminal()
		requestShellSingleProbe()
		const x = io()
		expect(runEmptyReadBranch(x)).toBe('skip_single_probe')
		expect(x.scheduled).toEqual([])
		expect(x.calls.some((c) => c.includes('retry attempt'))).toBe(false)
	})
})

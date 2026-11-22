/**
 * Terminal state of a fallback shell start.
 *
 * Once the gate has decided the update prompt (a confirmed-empty page store on a shell whose native record command is absent),
 * nothing re-reads the store on a timer: the App's empty-read retry and the gate's startup retry stay off. Only the user's Retry
 * runs one probe. If that probe is still empty, the gate decides the terminal again.
 *
 * Module state is per page process. Pure apart from the listener set; no storage, bridge or network access here.
 */

let terminal = false
let singleProbe = false
/** The last shell read was a not_ready that the ceiling ends (bounded, or final): the App does not schedule its own re-reads (v4). */
let readHold: 'none' | 'bounded' | 'final' = 'none'
export function setShellReadHold(hold: 'none' | 'bounded' | 'final'): void {
	readHold = hold
}
const listeners = new Set<(isTerminal: boolean) => void>()

function notify(): void {
	for (const listener of listeners) listener(terminal)
}

/** The gate decided the terminal update prompt. Clears any pending single probe; listeners stop their timers. */
export function markShellTerminal(): void {
	terminal = true
	singleProbe = false
	notify()
}

/**
 * Decides the terminal and then runs the diagnostic that reports it (the terminal line was printed before the
 * state was set, and a read that landed in that gap scheduled a retry). The state is set first; the line and any await or render follow.
 */
export function decideShellTerminal(report: () => void): void {
	markShellTerminal()
	report()
}

export function isShellTerminal(): boolean {
	return terminal
}

/**
 * The user's Retry on the terminal screen: leaves the terminal and allows exactly one probe. The next empty answer of that probe does
 * not schedule anything (see takeShellSingleProbe); the gate decides the terminal again.
 */
export function requestShellSingleProbe(): void {
	terminal = false
	singleProbe = true
	notify()
}

/**
 * True once for the single probe requested by Retry. The App's empty-read branch calls it: a true answer means this empty read
 * schedules no re-read. A second empty read finds no pending probe and follows the normal policy only if not terminal.
 */
export function takeShellSingleProbe(): boolean {
	if (!singleProbe) return false
	singleProbe = false
	return true
}

/**
 * The App's decision at the point of an empty read (checked when the empty answer arrives, not when the init started, so a terminal
 * decided while the init was awaiting its read is honoured): `skip_terminal` schedules nothing and logs no retry; `skip_single_probe`
 * is the one probe after Retry (nothing scheduled); `schedule` is the normal bounded re-read.
 */
export type EmptyReadAction = 'skip_terminal' | 'skip_single_probe' | 'schedule'
export function emptyReadAction(): EmptyReadAction {
	if (terminal || readHold !== 'none') return 'skip_terminal'
	if (takeShellSingleProbe()) return 'skip_single_probe'
	return 'schedule'
}

/**
 * The shell's empty-read branch of the App init (the only emitter of the bounded re-read line). A terminal decided at any point
 * before this branch runs schedules nothing and logs nothing: the terminal is checked by emptyReadAction, and again right before any
 * log or schedule. The App passes its counter, its delay ladder, its logger and its scheduler; the branch decides only.
 * Returns what it did: skip_terminal, skip_single_probe, or scheduled.
 */
export function runEmptyReadBranch(io: {
	nextAttempt: () => number
	delayFor: (attempt: number) => number
	log: (line: string) => void
	schedule: (delayMs: number) => void
}): EmptyReadAction {
	const action = emptyReadAction()
	if (action === 'skip_terminal') return action
	if (action === 'skip_single_probe') {
		io.log('[AppShell] init skip: the single probe after Retry is still empty; nothing scheduled')
		return action
	}
	// the checks are repeated before each line and before the timer: a terminal set in the meantime schedules nothing and logs nothing more
	if (terminal) return 'skip_terminal'
	io.log('[AppShell] init skip: shell has no account read yet; the entry gate decides and init runs again')
	if (terminal) return 'skip_terminal'
	const attempt = io.nextAttempt()
	const delay = io.delayFor(attempt)
	if (terminal) return 'skip_terminal'
	io.log(`[AppShell] init skip: retry attempt ${attempt}, next in ${delay} ms`)
	if (terminal) return 'skip_terminal'
	io.schedule(delay)
	return 'schedule'
}

/** Listens to terminal changes (the App clears its pending re-read timer when the terminal is decided). Returns an unsubscribe. */
export function subscribeShellTerminal(listener: (isTerminal: boolean) => void): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

/** Test and unmount helper: back to the initial state. */
export function resetShellTerminalState(): void {
	terminal = false
	singleProbe = false
	listeners.clear()
}

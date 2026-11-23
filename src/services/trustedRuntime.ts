/**
 * The runtime gate (RUNTIME-GATE v2.3, one source of truth for "may this page take a browser key path").
 * One ZIP serves the browser, the iOS shell and the Android shell. Nothing is decided at build time: the signals below decide at run time.
 *
 * Signals:
 * - S1: the document origin is a shell origin (iOS cashtrees-local://localhost, Android https://appassets.androidplatform.net).
 *   S1 is the only basis for "inside a shell"; a page script cannot set it.
 * - S2: the document-start marker `window.__beamioShellNonce` (writable:false, configurable:false), injected only by a new shell.
 * - B: a shell bridge object (CashTreesIOS, CashTreesAndroid, BeamioChat, BeamioShell, BeamioShellRecord). Used only to fail closed.
 * - S3: the `hello` answer (nonce, shellProtocol, s2Unsupported). Dynamic: each retry asks again.
 *
 * The browser needs zero signals. Any shell signal outside S1 is unavailable (fail closed). A shell is never downgraded to browser.
 * The only allowed move out of legacy-shell is the Q12 upgrade to shell-unavailable (S3 arrives late with shellProtocol).
 * The pure functions here take their inputs as arguments; the window reads are in readSignalsNow and readQaFlag.
 */

export type RuntimeMode = 'probing' | 'browser' | 'legacy-shell' | 'shell-pending' | 'shell-ready' | 'shell-unavailable'

/** The shell origins of S1 (CashTreesBridgeSource.swift shellOrigin; EmbeddedPwaConstants.ASSET_LOADER_DOMAIN). */
export const SHELL_ORIGINS: readonly string[] = ['cashtrees-local://localhost', 'https://appassets.androidplatform.net']

/** Bridge objects of B. */
export const SHELL_BRIDGE_NAMES: readonly string[] = ['CashTreesIOS', 'CashTreesAndroid', 'BeamioChat', 'BeamioShell', 'BeamioShellRecord']

/** The bounded hello timeout (RUNTIME-GATE 2.9, Q3 / R75). After it the start-up wait shows the retry button. */
export const HELLO_TIMEOUT_MS = 10_000

export type StaticSignals = { s1: boolean; s2: boolean; bridge: boolean }

/** The S3 state as the page knows it. `refused` is an error answer (ok:false) and counts as no shell answer. */
export type HelloState =
	| { kind: 'pending' }
	| { kind: 'timed_out' }
	| { kind: 'refused' }
	| { kind: 'answered'; nonce?: string; shellProtocol?: unknown; s2Unsupported?: boolean }

export const SIGNALS_NONE: StaticSignals = { s1: false, s2: false, bridge: false }

/** RUNTIME-GATE 2.3 (the decision table). Pure. */
export function classifyRuntime(sig: StaticSignals, hello: HelloState, s2Nonce: string | null): RuntimeMode {
	if (!sig.s1 && !sig.s2 && !sig.bridge) return 'browser'
	// a shell signal outside the shell origin: a page that fakes a bridge or the marker never gets a browser key path
	if (!sig.s1) return 'shell-unavailable'
	if (sig.s2) {
		if (hello.kind === 'pending' || hello.kind === 'timed_out') return 'shell-pending'
		if (hello.kind === 'refused') return 'shell-unavailable'
		// S2 and S3 must agree, and S3 must carry shellProtocol (a shell that injects S2 but answers without it is unavailable)
		const agree = typeof hello.nonce === 'string' && s2Nonce !== null && hello.nonce === s2Nonce
		return agree && hello.shellProtocol !== undefined ? 'shell-ready' : 'shell-unavailable'
	}
	// S1 without S2: an old shell, or a new shell whose injection failed
	if (hello.kind === 'pending' || hello.kind === 'refused') return 'shell-pending'
	if (hello.kind === 'timed_out') return 'legacy-shell'
	if (hello.shellProtocol === undefined) return 'legacy-shell'
	return hello.s2Unsupported === true ? 'legacy-shell' : 'shell-unavailable'
}

/** The allowed moves (RUNTIME-GATE 2.4, Q12). Anything else is refused: the state stays. */
const ALLOWED: Record<RuntimeMode, readonly RuntimeMode[]> = {
	probing: ['browser', 'legacy-shell', 'shell-pending', 'shell-ready', 'shell-unavailable'],
	browser: ['shell-unavailable'],
	'shell-pending': ['shell-ready', 'shell-unavailable', 'legacy-shell'],
	'shell-ready': [],
	'shell-unavailable': ['shell-pending'],
	// Q12: the only move out of legacy-shell is the failing-closed upgrade
	'legacy-shell': ['shell-unavailable'],
}

export function isAllowedMove(from: RuntimeMode, to: RuntimeMode): boolean {
	return from === to || ALLOWED[from].includes(to)
}

type Machine = {
	state: RuntimeMode
	/** true once the page has been unavailable: a shell never returns to legacy-shell afterwards (no downgrade). */
	sawUnavailable: boolean
	hello: HelloState
	s2Nonce: string | null
	signals: StaticSignals
}

const machine: Machine = { state: 'probing', sawUnavailable: false, hello: { kind: 'pending' }, s2Nonce: null, signals: SIGNALS_NONE }

function move(to: RuntimeMode): void {
	const from = machine.state
	if (from === to) return
	if (!isAllowedMove(from, to)) return
	// no downgrade: after an unavailable verdict, pending never becomes legacy-shell
	if (to === 'legacy-shell' && machine.sawUnavailable) return
	machine.state = to
	if (to === 'shell-unavailable') machine.sawUnavailable = true
}

function recompute(): void {
	move(classifyRuntime(machine.signals, machine.hello, machine.s2Nonce))
}

/** Reads S1, S2 and B from the window. A missing window reads as no signal. */
export type WindowLike = Record<string, unknown>

export function readSignalsNow(win: WindowLike | undefined = typeof window === 'undefined' ? undefined : (window as unknown as WindowLike)): { signals: StaticSignals; s2Nonce: string | null } {
	if (!win) return { signals: SIGNALS_NONE, s2Nonce: null }
	const origin = String((win.location as { origin?: unknown } | undefined)?.origin ?? '')
	const s1 = SHELL_ORIGINS.includes(origin)
	const nonce = win.__beamioShellNonce
	const s2 = typeof nonce === 'string' && nonce !== ''
	const bridge = SHELL_BRIDGE_NAMES.some((n) => win[n] !== undefined)
	return { signals: { s1, s2, bridge }, s2Nonce: s2 ? (nonce as string) : null }
}

/** Reads the signals once at start and takes the first verdict (browser with no signals, else pending until the hello). */
export function initTrustedRuntime(win?: WindowLike | undefined): RuntimeMode {
	const read = readSignalsNow(win)
	machine.signals = read.signals
	machine.s2Nonce = read.s2Nonce
	machine.hello = { kind: 'pending' }
	machine.sawUnavailable = false
	machine.state = 'probing'
	recompute()
	return machine.state
}

/** The S3 answer (the hello reply, a timeout, or a refusal). Moves the state by the table; never to browser. */
export function applyHello(hello: HelloState): RuntimeMode {
	machine.hello = hello
	recompute()
	return machine.state
}

/** The retry button: an unavailable or pending shell asks again. The state moves to pending; the caller re-sends hello. */
export function retryShellHandshake(): RuntimeMode {
	if (machine.state === 'shell-unavailable') move('shell-pending')
	machine.hello = { kind: 'pending' }
	return machine.state
}

/** The state as last decided (no re-read). */
export function runtimeState(): RuntimeMode {
	return machine.state
}

/**
 * The browser key-path guard. Re-reads the signals on every call: a browser page whose shell signals appear later is
 * unavailable from then on (RUNTIME-GATE 2.4 (4)). Never true outside the browser state.
 */
export function isBrowserKeyPath(win?: WindowLike | undefined): boolean {
	const read = readSignalsNow(win)
	if (machine.state === 'browser' && (read.signals.s1 || read.signals.s2 || read.signals.bridge)) {
		machine.signals = read.signals
		machine.s2Nonce = read.s2Nonce
		recompute()
	}
	return machine.state === 'browser'
}

/** The "inside a shell" test for every non-key decision: true in any state but browser (fail closed while probing). */
export function isShellRuntimeNow(win?: WindowLike | undefined): boolean {
	return !isBrowserKeyPath(win)
}

/** Throws `code` when the page is not in the browser state. Used at the key-path sites (site names are for the log only). */
export function assertBrowserKeyPath(code: string, win?: WindowLike | undefined): void {
	if (!isBrowserKeyPath(win)) throw new Error(code)
}

/** The QA flags (RUNTIME-GATE 4.2, 4.3): only a QA shell injects `window.__BEAMIO_QA_FLAGS__`; a Release page reads false. */
export function readQaFlag(name: 'bootTrace' | 'pgpIdentityCreate', win?: WindowLike): boolean {
	const root = win ?? (typeof window === 'undefined' ? undefined : (window as unknown as WindowLike))
	const flags = root?.__BEAMIO_QA_FLAGS__
	if (!flags || typeof flags !== 'object') return false
	return (flags as Record<string, unknown>)[name] === true
}

/**
 * The hello probe (RUNTIME-GATE 2.9): asks once, and turns no answer into `timed_out` after HELLO_TIMEOUT_MS. The send returns the
 * answer, or `refused` for an error answer. A browser state is not probed.
 */
export function startHelloProbe(send: () => Promise<HelloState>, timeoutMs: number = HELLO_TIMEOUT_MS): Promise<RuntimeMode> {
	if (machine.state === 'browser') return Promise.resolve(machine.state)
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<HelloState>((resolve) => {
		timer = setTimeout(() => resolve({ kind: 'timed_out' }), timeoutMs)
	})
	return Promise.race([send().catch((): HelloState => ({ kind: 'refused' })), timeout]).then((h) => {
		if (timer !== undefined) clearTimeout(timer)
		return applyHello(h)
	})
}

/** Tests only: the machine back to its initial state. */
export function resetTrustedRuntimeForTests(): void {
	machine.state = 'probing'
	machine.sawUnavailable = false
	machine.hello = { kind: 'pending' }
	machine.s2Nonce = null
	machine.signals = SIGNALS_NONE
}

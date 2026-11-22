/**
 * Runtime gate: the runtime decision table, the transitions and the QA flags. Pure: the window is a plain
 * object. SYNTHETIC values only.
 */
import {
	HELLO_TIMEOUT_MS,
	SIGNALS_NONE,
	applyHello,
	classifyRuntime,
	initTrustedRuntime,
	isAllowedMove,
	isBrowserKeyPath,
	readQaFlag,
	readSignalsNow,
	resetTrustedRuntimeForTests,
	retryShellHandshake,
	runtimeState,
	startHelloProbe,
} from './trustedRuntime'

const S1 = { s1: true, s2: false, bridge: false }
const S1S2 = { s1: true, s2: true, bridge: false }
const SHELL_ORIGIN = { location: { origin: 'cashtrees-local://localhost' } }
const NONCE = '0x' + 'ab'.repeat(16)

describe('decision table', () => {
	it('the browser needs zero signals', () => {
		expect(classifyRuntime(SIGNALS_NONE, { kind: 'pending' }, null)).toBe('browser')
	})

	it('a bridge object or the marker outside the shell origin is unavailable, never a browser (fake shell, fail closed)', () => {
		expect(classifyRuntime({ s1: false, s2: false, bridge: true }, { kind: 'pending' }, null)).toBe('shell-unavailable')
		expect(classifyRuntime({ s1: false, s2: true, bridge: false }, { kind: 'pending' }, NONCE)).toBe('shell-unavailable')
	})

	it('S1 and S2 with no hello answer yet, or a timed-out answer: pending (never browser, never onboarding)', () => {
		expect(classifyRuntime(S1S2, { kind: 'pending' }, NONCE)).toBe('shell-pending')
		expect(classifyRuntime(S1S2, { kind: 'timed_out' }, NONCE)).toBe('shell-pending')
	})

	it('S2 and S3 agree with shellProtocol: ready; a nonce mismatch or a refusal: unavailable', () => {
		expect(classifyRuntime(S1S2, { kind: 'answered', nonce: NONCE, shellProtocol: 1 }, NONCE)).toBe('shell-ready')
		expect(classifyRuntime(S1S2, { kind: 'answered', nonce: '0x' + '11'.repeat(16), shellProtocol: 1 }, NONCE)).toBe('shell-unavailable')
		expect(classifyRuntime(S1S2, { kind: 'refused' }, NONCE)).toBe('shell-unavailable')
	})

	it('a ready answer is decided without the capability bit (the capabilities gate the features, not the mode)', () => {
		expect(classifyRuntime(S1S2, { kind: 'answered', nonce: NONCE, shellProtocol: 1 }, NONCE)).toBe('shell-ready')
	})

	it('S2 present but S3 without shellProtocol (a publication-order violation): unavailable', () => {
		expect(classifyRuntime(S1S2, { kind: 'answered', nonce: NONCE }, NONCE)).toBe('shell-unavailable')
	})

	it('S1 without S2: an old shell. Timed out, or an answer without shellProtocol: legacy-shell', () => {
		expect(classifyRuntime(S1, { kind: 'timed_out' }, null)).toBe('legacy-shell')
		expect(classifyRuntime(S1, { kind: 'answered' }, null)).toBe('legacy-shell')
		expect(classifyRuntime(S1, { kind: 'pending' }, null)).toBe('shell-pending')
	})

	it('S1 without S2, S3 with shellProtocol: legacy only when the shell declares s2Unsupported; otherwise unavailable', () => {
		expect(classifyRuntime(S1, { kind: 'answered', shellProtocol: 1, s2Unsupported: true }, null)).toBe('legacy-shell')
		expect(classifyRuntime(S1, { kind: 'answered', shellProtocol: 1 }, null)).toBe('shell-unavailable')
	})
})

describe('transitions', () => {
	it('the moves the table allows', () => {
		expect(isAllowedMove('probing', 'browser')).toBe(true)
		expect(isAllowedMove('shell-pending', 'shell-ready')).toBe(true)
		expect(isAllowedMove('shell-unavailable', 'shell-pending')).toBe(true)
		expect(isAllowedMove('legacy-shell', 'shell-unavailable')).toBe(true)
		expect(isAllowedMove('browser', 'shell-unavailable')).toBe(true)
	})

	it('the moves it forbids: no return to browser, no downgrade, no pending from legacy, and ready is final', () => {
		expect(isAllowedMove('shell-pending', 'browser')).toBe(false)
		expect(isAllowedMove('shell-unavailable', 'browser')).toBe(false)
		expect(isAllowedMove('shell-unavailable', 'legacy-shell')).toBe(false)
		expect(isAllowedMove('legacy-shell', 'browser')).toBe(false)
		expect(isAllowedMove('legacy-shell', 'shell-pending')).toBe(false)
		expect(isAllowedMove('shell-ready', 'shell-pending')).toBe(false)
	})
})

describe('the machine (initialised from the window, the hello answer applied)', () => {
	beforeEach(() => {
		resetTrustedRuntimeForTests()
	})

	it('a plain browser window is browser at once, and the key path is open', () => {
		expect(initTrustedRuntime({})).toBe('browser')
		expect(isBrowserKeyPath({})).toBe(true)
	})

	it('a shell origin without the marker waits for the hello; the key path is closed while pending', () => {
		expect(initTrustedRuntime(SHELL_ORIGIN)).toBe('shell-pending')
		expect(isBrowserKeyPath(SHELL_ORIGIN)).toBe(false)
		expect(runtimeState()).toBe('shell-pending')
	})

	it('a timed-out hello under S1 without S2 becomes legacy-shell, the old shell path (no browser key path)', () => {
		initTrustedRuntime(SHELL_ORIGIN)
		expect(applyHello({ kind: 'timed_out' })).toBe('legacy-shell')
		expect(isBrowserKeyPath(SHELL_ORIGIN)).toBe(false)
	})

	it('Q12: legacy-shell upgrades to unavailable when S3 arrives late with shellProtocol; it never returns to browser or pending', () => {
		initTrustedRuntime(SHELL_ORIGIN)
		applyHello({ kind: 'timed_out' })
		expect(runtimeState()).toBe('legacy-shell')
		expect(applyHello({ kind: 'answered', shellProtocol: 1 })).toBe('shell-unavailable')
		expect(applyHello({ kind: 'timed_out' })).toBe('shell-unavailable')
		expect(isBrowserKeyPath(SHELL_ORIGIN)).toBe(false)
	})

	it('no downgrade (v): after unavailable, a retry that times out stays pending, never legacy-shell (an S1-only shell, no marker)', () => {
		initTrustedRuntime(SHELL_ORIGIN)
		// S1 only, S3 with shellProtocol and no s2Unsupported: a new shell whose injection failed, unavailable
		expect(applyHello({ kind: 'answered', shellProtocol: 1 })).toBe('shell-unavailable')
		retryShellHandshake()
		expect(runtimeState()).toBe('shell-pending')
		// classification of this window would be legacy-shell on timeout; the sawUnavailable guard keeps it pending
		expect(classifyRuntime(S1, { kind: 'timed_out' }, null)).toBe('legacy-shell')
		expect(applyHello({ kind: 'timed_out' })).toBe('shell-pending')
	})

	it('a browser page whose shell signals appear later is unavailable from then on (the guard re-reads the signals)', () => {
		initTrustedRuntime({})
		expect(isBrowserKeyPath({})).toBe(true)
		expect(isBrowserKeyPath({ CashTreesIOS: {} })).toBe(false)
		expect(runtimeState()).toBe('shell-unavailable')
		expect(isBrowserKeyPath({})).toBe(false)
	})

	it('a shell with S2 and a hello that never answers stays pending: no timeout exit (2.9)', async () => {
		jest.useFakeTimers()
		try {
			initTrustedRuntime({ location: { origin: 'cashtrees-local://localhost' }, __beamioShellNonce: NONCE })
			const p = startHelloProbe(() => new Promise(() => undefined), 1000)
			jest.advanceTimersByTime(1000)
			expect(await p).toBe('shell-pending')
			expect(HELLO_TIMEOUT_MS).toBe(10_000)
		} finally {
			jest.useRealTimers()
		}
	})

	it('a browser window is never probed (the probe is a no-op)', async () => {
		initTrustedRuntime({})
		const send = jest.fn(async () => ({ kind: 'pending' as const }))
		expect(await startHelloProbe(send, 10)).toBe('browser')
		expect(send).not.toHaveBeenCalled()
	})
})

describe('readers', () => {
	it('readSignalsNow reads the origin, the marker and the bridge names', () => {
		expect(readSignalsNow({ location: { origin: 'https://appassets.androidplatform.net' } }).signals).toEqual({ s1: true, s2: false, bridge: false })
		expect(readSignalsNow({ __beamioShellNonce: NONCE }).signals).toEqual({ s1: false, s2: true, bridge: false })
		expect(readSignalsNow({ BeamioChat: {} }).signals).toEqual({ s1: false, s2: false, bridge: true })
	})

	it('the QA flags are read only from the frozen object; a Release page (no object) reads false (4.2, 4.3)', () => {
		expect(readQaFlag('bootTrace', {})).toBe(false)
		expect(readQaFlag('pgpIdentityCreate', { __BEAMIO_QA_FLAGS__: { pgpIdentityCreate: true } })).toBe(true)
		expect(readQaFlag('bootTrace', { __BEAMIO_QA_FLAGS__: { pgpIdentityCreate: true } })).toBe(false)
	})
})

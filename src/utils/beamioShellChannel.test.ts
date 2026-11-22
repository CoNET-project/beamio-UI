/**
 * the `window.BeamioShell`channel. A message is a JSON string `{action, reqId, args}`; the
 * shell answers each message once with a JSON string `{type:"ack", action, reqId, ok, result?, error?}`. Only the error code is logged.
 * SYNTHETIC values only.
 */
import { publishNativePwaLog } from './cashTreesNativePwaLog'
import {
	BEAMIO_SHELL_ACTIONS,
	hasBeamioShell,
	installBeamioShellReceiver,
	postBeamioShell,
	requestBeamioShell,
	SHELL_NOT_SUPPORTED,
	SHELL_TIMEOUT,
} from './beamioShellChannel'

jest.mock('./cashTreesNativePwaLog', () => ({
	publishNativePwaLog: jest.fn(),
}))

const w = window as unknown as { BeamioShell?: unknown }

type Sent = { action: string; reqId: number; args: unknown }

/** A fake shell: each posted message is parsed and recorded; `respond` returns the ack fields, or null for no answer. */
function fakeShell(respond: (sent: Sent) => Record<string, unknown> | null) {
	const sent: Sent[] = []
	const host: { postMessage: jest.Mock; onmessage?: ((ev: unknown) => void) | null } = {
		postMessage: jest.fn((raw: unknown) => {
			const msg = JSON.parse(String(raw)) as Sent
			sent.push(msg)
			const answer = respond(msg)
			if (answer) {
				queueMicrotask(() =>
					host.onmessage?.({ data: JSON.stringify({ type: 'ack', action: msg.action, reqId: msg.reqId, ...answer }) }),
				)
			}
		}),
		onmessage: null,
	}
	w.BeamioShell = host
	return { host, sent }
}

beforeEach(() => {
	jest.useRealTimers()
	;(publishNativePwaLog as jest.Mock).mockReset()
})

afterEach(() => {
	delete w.BeamioShell
})

describe('the action list', () => {
	it('is the 25 actions: the 21 of the spec plus dismissIncomingSystemCall, the two voiceEphemeral actions and incomingCallUnlockShown', () => {
		expect([...BEAMIO_SHELL_ACTIONS].sort()).toEqual(
			[
				'bindPushIdentity',
				'cacheCallerAvatars',
				'cancelPreparedSystemCall',
				'dismissIncomingSystemCall',
				'endSystemCall',
				'incomingCallUnlockShown',
				'listInstalledWalletApps',
				'notifyVoiceMicReady',
				'openInAppBrowser',
				'openURL',
				'postPgpCiphertext',
				'prepareSystemCall',
				'queryIncomingCallOutcome',
				'queryInstalledApps',
				'reportIncomingSystemCall',
				'requestCameraCapture',
				'saveFile',
				'scanQr',
				'setNativeSiNodeRoster',
				'setNativeVoiceRelayNodes',
				'startNativeVoiceMic',
				'startSystemCall',
				'stopNativeVoiceMic',
				'voiceEphemeralForget',
				'voiceEphemeralPrepare',
			].sort(),
		)
		expect(new Set(BEAMIO_SHELL_ACTIONS).size).toBe(25)
		expect(BEAMIO_SHELL_ACTIONS).not.toContain('scanRecoveryQr')
	})
})

describe('without window.BeamioShell', () => {
	it('is not present; a request resolves not_supported and nothing is posted', async () => {
		expect(hasBeamioShell()).toBe(false)
		await expect(requestBeamioShell('openURL', { url: 'https://example.com' })).resolves.toEqual({
			ok: false,
			error: SHELL_NOT_SUPPORTED,
		})
		expect(postBeamioShell('openURL', { url: 'https://example.com' })).toBe(false)
	})

	it('the receiver is not installed', () => {
		expect(installBeamioShellReceiver()).toBeNull()
	})
})

describe('a request', () => {
	it('is one JSON string {action, reqId, args}; the ack resolves it with its result', async () => {
		const { host, sent } = fakeShell(() => ({ ok: true, result: ['metamask'] }))
		installBeamioShellReceiver()
		const ack = await requestBeamioShell('queryInstalledApps', { requestId: 'r1', queries: [] })
		expect(ack).toEqual({ ok: true, result: ['metamask'] })
		expect(typeof host.postMessage.mock.calls[0][0]).toBe('string')
		expect(sent).toHaveLength(1)
		expect(sent[0].action).toBe('queryInstalledApps')
		expect(Number.isInteger(sent[0].reqId)).toBe(true)
		expect(sent[0].args).toEqual({ requestId: 'r1', queries: [] })
	})

	it('a refused ack resolves ok:false with the code only', async () => {
		fakeShell(() => ({ ok: false, error: 'bad_args' }))
		installBeamioShellReceiver()
		await expect(requestBeamioShell('scanQr', { requestId: 'x' })).resolves.toEqual({ ok: false, error: 'bad_args' })
	})

	it('with no answer it resolves timeout', async () => {
		jest.useFakeTimers()
		fakeShell(() => null)
		installBeamioShellReceiver()
		const pending = requestBeamioShell('scanQr', { requestId: 'x' }, 1000)
		jest.advanceTimersByTime(1000)
		await expect(pending).resolves.toEqual({ ok: false, error: SHELL_TIMEOUT })
	})

	it('a message that is not a string, or is not an ack, or has an unknown reqId is dropped', () => {
		const { host } = fakeShell(() => null)
		installBeamioShellReceiver()
		expect(() => host.onmessage?.({ data: { type: 'ack', reqId: 1, ok: true } })).not.toThrow()
		expect(() => host.onmessage?.({ data: 'not json' })).not.toThrow()
		expect(() => host.onmessage?.({ data: JSON.stringify({ type: 'event', reqId: 1 }) })).not.toThrow()
		expect(() => host.onmessage?.({ data: JSON.stringify({ type: 'ack', reqId: 999999999, ok: true }) })).not.toThrow()
		expect(publishNativePwaLog).not.toHaveBeenCalled()
	})
})

describe('a fire-and-forget post', () => {
	it('is posted as a string and returns true; a refusal is logged by code only, never the payload', async () => {
		const { host, sent } = fakeShell(() => ({ ok: false, error: 'origin_refused' }))
		installBeamioShellReceiver()
		expect(postBeamioShell('saveFile', { dataUrl: 'data:text/plain;base64,SYNTHETIC', filename: 'a.txt' })).toBe(true)
		expect(typeof host.postMessage.mock.calls[0][0]).toBe('string')
		expect(sent[0].action).toBe('saveFile')
		await new Promise((resolve) => setTimeout(resolve, 0))
		const logged = (publishNativePwaLog as jest.Mock).mock.calls.map((c) => String(c[1])).join('\n')
		expect(logged).toContain('origin_refused')
		expect(logged).not.toContain('SYNTHETIC')
		expect(logged).not.toContain('dataUrl')
	})
})

describe('the receiver', () => {
	it('restores the previous onmessage when it is removed', () => {
		const previous = jest.fn()
		const { host } = fakeShell(() => null)
		host.onmessage = previous
		const off = installBeamioShellReceiver()
		expect(host.onmessage).not.toBe(previous)
		off?.()
		expect(host.onmessage).toBe(previous)
	})
})

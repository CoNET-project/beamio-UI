/**
 * the Android sensitive methods go through `window.BeamioShell`when it is present.
 * The legacy `CashTreesAndroid` method is still used only when it is not. queryInstalledApps is an asynchronous ack. SYNTHETIC values.
 */
import { publishNativePwaLog } from './cashTreesNativePwaLog'
import { installBeamioShellReceiver } from './beamioShellChannel'
import {
	androidShellOwnsCallAudio,
	dispatchNativeSystemCallAction,
	getCashTreesNativeNfcHost,
	listInstalledWalletAppsFromNative,
	nativeSaveFileAvailable,
	notifyNativeVoiceMicReady,
	openExternalUrl,
	consumeReservedExternalWindow,
	navigateReservedOrOpenExternal,
	reserveExternalBrowserWindow,
	openCoinbaseCheckoutUrl,
	openInAppBrowser,
	setNativeVoiceRelayNodes,
	startNativeVoiceMic,
	stopNativeVoiceMic,
} from './cashTreesNativeNfc'

jest.mock('./cashTreesNativePwaLog', () => ({
	publishNativePwaLog: jest.fn(),
}))

const w = window as unknown as { BeamioShell?: unknown; CashTreesAndroid?: unknown; CashTreesIOS?: unknown }

type Sent = { action: string; reqId: number; args: unknown }

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
	installBeamioShellReceiver()
	return { host, sent }
}

beforeEach(() => {
	;(publishNativePwaLog as jest.Mock).mockReset()
})

afterEach(() => {
	delete w.BeamioShell
	delete w.CashTreesAndroid
	delete w.CashTreesIOS
	jest.restoreAllMocks()
})

describe('the shell alone makes this an Android shell', () => {
	it('host is android and the save-file path exists, with no CashTreesAndroid object', () => {
		fakeShell(() => null)
		expect(getCashTreesNativeNfcHost()).toBe('android')
		expect(nativeSaveFileAvailable()).toBe(true)
		expect(androidShellOwnsCallAudio()).toBe(true)
	})
})

describe('queryInstalledApps is an asynchronous ack ', () => {
	it('returns a promise, filters the ids to the queried apps, and never calls the legacy method', async () => {
		const legacy = { queryInstalledApps: jest.fn(() => '["metamask"]') }
		w.CashTreesAndroid = legacy
		const { sent } = fakeShell(() => ({ ok: true, result: ['metamask', 'okx'] }))
		const out = listInstalledWalletAppsFromNative([{ id: 'metamask', schemes: [], packages: [] }])
		expect(out).toBeInstanceOf(Promise)
		await expect(out).resolves.toEqual(['metamask'])
		expect(sent[0].action).toBe('queryInstalledApps')
		expect(legacy.queryInstalledApps).not.toHaveBeenCalled()
	})

	it('a refused ack resolves null (the shell has no catalog answer)', async () => {
		fakeShell(() => ({ ok: false, error: 'not_ready' }))
		await expect(listInstalledWalletAppsFromNative([{ id: 'metamask', schemes: [], packages: [] }])).resolves.toBeNull()
	})
})

describe('the voice mic', () => {
	it('start resolves with the ack boolean; a false result or a refusal is false', async () => {
		let answer: Record<string, unknown> = { ok: true, result: true }
		fakeShell((sent) => (sent.action === 'startNativeVoiceMic' ? answer : null))
		await expect(startNativeVoiceMic()).resolves.toBe(true)
		answer = { ok: true, result: false }
		await expect(startNativeVoiceMic()).resolves.toBe(false)
		answer = { ok: false, error: 'not_ready' }
		await expect(startNativeVoiceMic()).resolves.toBe(false)
	})

	it('stop posts stopNativeVoiceMic with empty args', () => {
		const { sent } = fakeShell(() => null)
		stopNativeVoiceMic()
		expect(sent[0]).toMatchObject({ action: 'stopNativeVoiceMic', args: {} })
	})
})

describe('fire-and-forget actions post their arguments as the object', () => {
	it('a system-call action posts its payload as args and returns true', () => {
		const { sent } = fakeShell(() => null)
		expect(dispatchNativeSystemCallAction('endSystemCall', { callId: 'c1' })).toBe(true)
		expect(sent[0]).toMatchObject({ action: 'endSystemCall', args: { callId: 'c1' } })
	})

	it('notifyVoiceMicReady posts callId and sessionId', () => {
		const { sent } = fakeShell(() => null)
		expect(notifyNativeVoiceMicReady({ callId: 'c2', sessionId: 's2' })).toBe(true)
		expect(sent[0]).toMatchObject({ action: 'notifyVoiceMicReady', args: { callId: 'c2', sessionId: 's2' } })
	})

	it('openExternalUrl sends openURL with {url} and opens no window', () => {
		const open = jest.spyOn(window, 'open')
		const { sent } = fakeShell(() => null)
		expect(openExternalUrl('https://example.com/a')).toBe(true)
		expect(sent[0]).toMatchObject({ action: 'openURL', args: { url: 'https://example.com/a' } })
		expect(open).not.toHaveBeenCalled()
	})

	it('setNativeVoiceRelayNodes posts the normalised nodes as {nodes}', () => {
		const { sent } = fakeShell(() => null)
		const ok = setNativeVoiceRelayNodes([
			{
				ip_addr: '10.0.0.1',
				domain: 'example.com',
				armoredPublicKey: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nSYNTHETIC\n-----END PGP PUBLIC KEY BLOCK-----',
			},
		])
		expect(ok).toBe(true)
		expect(sent[0].action).toBe('setNativeVoiceRelayNodes')
		expect((sent[0].args as { nodes: Array<{ ip: string; domain: string }> }).nodes[0]).toMatchObject({
			ip: '10.0.0.1',
			domain: 'EXAMPLE.COM',
		})
	})
})

describe('without window.BeamioShell the legacy method is unchanged', () => {
	it('dispatchNativeSystemCallAction still calls CashTreesAndroid with the JSON string', () => {
		const legacy = { endSystemCall: jest.fn() }
		w.CashTreesAndroid = legacy
		expect(dispatchNativeSystemCallAction('endSystemCall', { callId: 'c3' })).toBe(true)
		expect(legacy.endSystemCall).toHaveBeenCalledWith(JSON.stringify({ action: 'endSystemCall', callId: 'c3' }))
	})
})

describe('every system-call action goes to the shell first and to the legacy method only without it', () => {
	const SYSTEM_ACTIONS = [
		'prepareSystemCall',
		'cancelPreparedSystemCall',
		'startSystemCall',
		'reportIncomingSystemCall',
		'endSystemCall',
		'cacheCallerAvatars',
		'queryIncomingCallOutcome',
	] as const

	it.each(SYSTEM_ACTIONS)('%s posts to window.BeamioShell with its payload as args, and the legacy method is not called', (action) => {
		const legacy: Record<string, jest.Mock> = {}
		legacy[action] = jest.fn()
		w.CashTreesAndroid = legacy
		const { sent } = fakeShell(() => ({ ok: true }))
		const payload = action === 'queryIncomingCallOutcome' ? { calls: [{ callId: 'c4', sessionId: 's4' }] } : { callId: 'c4' }
		expect(dispatchNativeSystemCallAction(action, payload)).toBe(true)
		expect(sent[0]).toMatchObject({ action, args: payload })
		expect(legacy[action]).not.toHaveBeenCalled()
	})

	it('queryIncomingCallOutcome keeps the {calls:[...]} input; its ack is ok:true and the result comes on cashtreesandroid', () => {
		const { sent } = fakeShell(() => ({ ok: true }))
		const calls = [{ callId: 'c5', sessionId: 's5' }]
		expect(dispatchNativeSystemCallAction('queryIncomingCallOutcome', { calls })).toBe(true)
		expect(sent[0]).toMatchObject({ action: 'queryIncomingCallOutcome', args: { calls } })
	})
})

describe('a URL the shell did not take is never opened another way', () => {
	it('a refused openURL (key_shaped_content) is final: no window.open and no second openURL or openInAppBrowser', async () => {
		const open = jest.spyOn(window, 'open').mockImplementation(() => null)
		const { sent } = fakeShell((msg) => (msg.action === 'openURL' ? { ok: false, error: 'key_shaped_content' } : null))
		const url = 'https://example.com/a?k=SYNTHETIC'
		expect(openExternalUrl(url)).toBe(true)
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(open).not.toHaveBeenCalled()
		expect(sent.map((m) => m.action)).toEqual(['openURL'])
		const logged = (publishNativePwaLog as jest.Mock).mock.calls.map((c) => String(c[1])).join('\n')
		expect(logged).toContain('key_shaped_content')
		expect(logged).not.toContain('SYNTHETIC')
	})

	it('a refused openInAppBrowser is final: no window.open and no openURL retry', async () => {
		const open = jest.spyOn(window, 'open').mockImplementation(() => null)
		const { sent } = fakeShell((msg) => (msg.action === 'openInAppBrowser' ? { ok: false, error: 'key_shaped_content' } : null))
		expect(openInAppBrowser('https://example.com/b?k=SYNTHETIC')).toBeTruthy()
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(open).not.toHaveBeenCalled()
		expect(sent.map((m) => m.action)).toEqual(['openInAppBrowser'])
	})

	it('when the shell cannot take the message at all, window.open is still not used', () => {
		const open = jest.spyOn(window, 'open').mockImplementation(() => null)
		w.BeamioShell = {
			postMessage: () => {
				throw new Error('bridge down')
			},
		}
		expect(openExternalUrl('https://example.com/c')).toBe(false)
		expect(open).not.toHaveBeenCalled()
	})

	it('without the shell, the browser path still uses window.open', () => {
		const open = jest.spyOn(window, 'open').mockImplementation(() => ({}) as Window)
		expect(openExternalUrl('https://example.com/d')).toBe(true)
		expect(open).toHaveBeenCalledWith('https://example.com/d', '_blank')
	})
})

describe('the Coinbase entry points keep the same rule', () => {
	it('a Coinbase trampoline (go.cb-w.com) refused by the shell is not opened another way', async () => {
		const open = jest.spyOn(window, 'open').mockImplementation(() => null)
		const { sent } = fakeShell((msg) => (msg.action === 'openURL' ? { ok: false, error: 'key_shaped_content' } : null))
		expect(openCoinbaseCheckoutUrl('https://go.cb-w.com/dapp?k=SYNTHETIC')).toBe(true)
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(open).not.toHaveBeenCalled()
		expect(sent.map((m) => m.action)).toEqual(['openURL'])
	})

	it('an onramp URL refused as openInAppBrowser is not opened another way', async () => {
		const open = jest.spyOn(window, 'open').mockImplementation(() => null)
		const { sent } = fakeShell((msg) => (msg.action === 'openInAppBrowser' ? { ok: false, error: 'key_shaped_content' } : null))
		expect(openCoinbaseCheckoutUrl('https://pay.coinbase.com/buy?k=SYNTHETIC')).toBeTruthy()
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(open).not.toHaveBeenCalled()
		expect(sent.map((m) => m.action)).toEqual(['openInAppBrowser'])
	})

	it('openInAppBrowser, when the shell cannot take the message, returns false and does not open window', () => {
		const open = jest.spyOn(window, 'open').mockImplementation(() => null)
		w.BeamioShell = {
			postMessage: () => {
				throw new Error('bridge down')
			},
		}
		expect(openInAppBrowser('https://example.com/e')).toBeFalsy()
		expect(open).not.toHaveBeenCalled()
	})
})

describe('the Coinbase reserved-window routes inside a shell go through openURL', () => {
	it('reserve in a shell returns null and opens no window', () => {
		const open = jest.spyOn(window, 'open').mockImplementation(() => null)
		fakeShell(() => null)
		expect(reserveExternalBrowserWindow()).toBeNull()
		expect(open).not.toHaveBeenCalled()
	})

	it('navigate in a shell sends openURL with {url} and opens no window', () => {
		const open = jest.spyOn(window, 'open').mockImplementation(() => null)
		const { sent } = fakeShell(() => null)
		expect(navigateReservedOrOpenExternal(null, 'https://pay.example.com/x')).toBe(true)
		expect(sent[0]).toMatchObject({ action: 'openURL', args: { url: 'https://pay.example.com/x' } })
		expect(open).not.toHaveBeenCalled()
	})

	it('a refused openURL from navigate is final: no window.open and no second message', async () => {
		const open = jest.spyOn(window, 'open').mockImplementation(() => null)
		const { sent } = fakeShell(() => ({ ok: false, error: 'key_shaped_content' }))
		expect(navigateReservedOrOpenExternal(null, 'https://pay.example.com/y?k=SYNTHETIC')).toBe(true)
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(open).not.toHaveBeenCalled()
		expect(sent.map((m) => m.action)).toEqual(['openURL'])
	})

	it('iOS shell (CashTreesIOS): navigate calls CashTreesIOS.openURL and opens no window', () => {
		const open = jest.spyOn(window, 'open').mockImplementation(() => null)
		const openURL = jest.fn()
		w.CashTreesIOS = { openURL, getNfcStatus: () => 'ready' }
		expect(reserveExternalBrowserWindow()).toBeNull()
		expect(navigateReservedOrOpenExternal(null, 'https://pay.example.com/z')).toBe(true)
		expect(openURL).toHaveBeenCalledWith({ url: 'https://pay.example.com/z' })
		expect(open).not.toHaveBeenCalled()
	})

	it('iOS shell without an openURL method: navigate returns false and opens no window', () => {
		const open = jest.spyOn(window, 'open').mockImplementation(() => null)
		w.CashTreesIOS = { getNfcStatus: () => 'ready' }
		expect(navigateReservedOrOpenExternal(null, 'https://pay.example.com/w')).toBe(false)
		expect(open).not.toHaveBeenCalled()
	})

	it('browser (no shell): reserve still opens the named blank window', () => {
		const open = jest.spyOn(window, 'open').mockImplementation(
			() => ({ closed: false, location: { href: 'about:blank' } }) as unknown as Window,
		)
		expect(reserveExternalBrowserWindow()).not.toBeNull()
		expect(open).toHaveBeenCalledWith('about:blank', 'beamio_external_handoff')
		consumeReservedExternalWindow()
	})
})

describe('a stale reserved window inside a shell is closed, and the URL goes through openURL', () => {
	it('navigate closes the reserved blank window and sends openURL; it does not navigate that window', () => {
		const open = jest.spyOn(window, 'open').mockImplementation(() => null)
		const { sent } = fakeShell(() => null)
		const close = jest.fn()
		const replace = jest.fn()
		const reserved = { closed: false, close, location: { href: 'about:blank', replace } } as unknown as Window
		expect(navigateReservedOrOpenExternal(reserved, 'https://pay.example.com/r')).toBe(true)
		expect(close).toHaveBeenCalledTimes(1)
		expect(replace).not.toHaveBeenCalled()
		expect(sent[0]).toMatchObject({ action: 'openURL', args: { url: 'https://pay.example.com/r' } })
		expect(open).not.toHaveBeenCalled()
	})
})

describe('an openInAppBrowser refused by the shell settles its close waiter once, now', () => {
	it('onClosed is called once with reason refused; a later close event for that request does nothing', async () => {
		const { sent } = fakeShell((msg) => (msg.action === 'openInAppBrowser' ? { ok: false, error: 'key_shaped_content' } : null))
		const onClosed = jest.fn()
		openInAppBrowser('https://example.com/i?k=SYNTHETIC', { onClosed })
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(onClosed).toHaveBeenCalledTimes(1)
		const detail = onClosed.mock.calls[0][0] as { requestId?: string; reason?: string; ok?: boolean; action?: string }
		expect(detail).toMatchObject({ action: 'inAppBrowserClosed', ok: false, reason: 'refused' })
		expect(typeof detail.requestId).toBe('string')
		expect((detail.requestId ?? '').length).toBeGreaterThan(0)
		expect(sent.map((m) => m.action)).toEqual(['openInAppBrowser'])
		// The pending entry was cleared: a close event for the same request does not call onClosed again.
		window.dispatchEvent(
			new CustomEvent('cashtreesandroid', {
				detail: { action: 'inAppBrowserClosed', requestId: detail.requestId, ok: true, reason: 'closed' },
			}),
		)
		expect(onClosed).toHaveBeenCalledTimes(1)
	})

	it('an ok ack does not settle the waiter: onClosed waits for the close event', async () => {
		fakeShell(() => ({ ok: true }))
		const onClosed = jest.fn()
		openInAppBrowser('https://example.com/j', { onClosed })
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(onClosed).not.toHaveBeenCalled()
	})
})

describe('the shell refusal of openURL is reported to the caller once', () => {
	it('openExternalUrl(url, onRefused) calls onRefused with the code, and opens no window', async () => {
		const open = jest.spyOn(window, 'open').mockImplementation(() => null)
		fakeShell((msg) => (msg.action === 'openURL' ? { ok: false, error: 'key_shaped_content' } : null))
		const onRefused = jest.fn()
		expect(openExternalUrl('https://pay.example.com/q?k=SYNTHETIC', onRefused)).toBe(true)
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(onRefused).toHaveBeenCalledTimes(1)
		expect(onRefused).toHaveBeenCalledWith('key_shaped_content')
		expect(open).not.toHaveBeenCalled()
	})

	it('navigateReservedOrOpenExternal passes onRefused through inside a shell', async () => {
		fakeShell((msg) => (msg.action === 'openURL' ? { ok: false, error: 'key_shaped_content' } : null))
		const onRefused = jest.fn()
		expect(navigateReservedOrOpenExternal(null, 'https://pay.example.com/s?k=SYNTHETIC', onRefused)).toBe(true)
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(onRefused).toHaveBeenCalledTimes(1)
	})

	it('an ok ack does not call onRefused', async () => {
		fakeShell(() => ({ ok: true }))
		const onRefused = jest.fn()
		expect(openExternalUrl('https://pay.example.com/t', onRefused)).toBe(true)
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(onRefused).not.toHaveBeenCalled()
	})
})

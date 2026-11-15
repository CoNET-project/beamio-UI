/**
 * The hello probe at the bridge: a refusal (ok false) and a timeout both count as unanswered, and declare nothing.
 * The shell is a stub that answers on the iOS channel the way the native side does. Synthetic values only.
 */
import { probeNativeCapabilities } from './nativeChatRouteRegister'
import { identityCapabilityFrom } from './shellEntryDecision'

type Reply = (command: { type: string; reqId: number }) => Record<string, unknown> | null

/** The iOS channel: each command is answered on the native event channel, or not at all when the reply is null. */
function stubShell(reply: Reply | null) {
	;(window as unknown as { CashTreesIOS?: unknown }).CashTreesIOS = {
		chatModuleCommand: (wire: { command: { type: string; reqId: number } }) => {
			if (!reply) return
			const payload = reply(wire.command)
			if (!payload) return
			window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event: payload } }))
		},
	}
}

afterEach(() => {
	delete (window as unknown as { CashTreesIOS?: unknown }).CashTreesIOS
})

describe('a refused hello (ok false) is unanswered and declares nothing', () => {
	it('a refusal that carries the capability list still counts as unanswered', async () => {
		stubShell((cmd) => ({ type: 'ack', reqId: cmd.reqId, ok: false, error: 'unknown_command', result: { capabilities: ['identity.native-keys.v1'] } }))
		const probe = await probeNativeCapabilities(1_000)
		expect(probe).toEqual({ answered: false, capabilities: [] })
		expect(identityCapabilityFrom(probe)).toBe('unanswered')
	})

	it('a refusal without a list is unanswered too', async () => {
		stubShell((cmd) => ({ type: 'ack', reqId: cmd.reqId, ok: false, error: 'not_ready' }))
		const probe = await probeNativeCapabilities(1_000)
		expect(identityCapabilityFrom(probe)).toBe('unanswered')
	})
})

describe('a timed-out hello is unanswered', () => {
	it('no answer within the timeout gives unanswered, with no capability', async () => {
		stubShell(null)
		const probe = await probeNativeCapabilities(30)
		expect(probe).toEqual({ answered: false, capabilities: [] })
		expect(identityCapabilityFrom(probe)).toBe('unanswered')
	})
})

describe('the control: an answered hello that declares the capability is declared', () => {
	it('a ready answer with identity.native-keys.v1 is declared', async () => {
		stubShell((cmd) => ({ type: 'ready', reqId: cmd.reqId, result: { capabilities: ['identity.native-keys.v1'] } }))
		const probe = await probeNativeCapabilities(1_000)
		expect(identityCapabilityFrom(probe)).toBe('declared')
	})
})

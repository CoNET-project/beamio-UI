/**
 * @jest-environment node
 */
/** The chat transport's request numbers are unique for the whole page: two clients never reuse one, and the range does not meet another base. */
import { createNativeConetChatClient } from './nativeConetChatTransport'
import { nextChatTransportReqId, CHAT_TRANSPORT_REQ_BASE, CHAT_TRANSPORT_REQ_LIMIT, PWA_WALLET_SYNC_REQ_BASE, IMPORT_REQ_BASE } from './reqIdSpaces'

describe('transport reqId space', () => {
	it('is monotonic, inside its own range, below the other bases', () => {
		const a = nextChatTransportReqId()
		const b = nextChatTransportReqId()
		expect(b).toBe(a + 1)
		expect(a).toBeGreaterThan(CHAT_TRANSPORT_REQ_BASE)
		expect(b).toBeLessThan(CHAT_TRANSPORT_REQ_LIMIT)
		// route register / shell record counter base 700,000,000, the shell channel 810,000,000, import 880,000,000, sync 900,000,000+
		expect(CHAT_TRANSPORT_REQ_LIMIT).toBeLessThanOrEqual(700_000_000)
		expect(IMPORT_REQ_BASE).toBeGreaterThan(CHAT_TRANSPORT_REQ_LIMIT)
		expect(PWA_WALLET_SYNC_REQ_BASE).toBeGreaterThan(CHAT_TRANSPORT_REQ_LIMIT)
	})
	it('two client instances never use the same request number (a late answer of a replaced client cannot match the new one)', () => {
		const sent: Array<Record<string, unknown>> = []
		const target = new EventTarget()
		;(globalThis as unknown as { window: unknown }).window = Object.assign(target, {
			CashTreesIOS: { chatModuleCommand: (p: { command: Record<string, unknown> }) => void sent.push(p.command) },
		})
		const config = { identity: { eoaAddress: '0x' + '11'.repeat(20), pgpPublicKeyArmored: 'x', ownRouteArmoredPublicKey: 'x' }, conetRpcUrl: 'https://rpc.invalid', getNodes: async () => [], ipfsBaseUrl: 'https://ipfs.invalid', apiBaseUrl: 'https://api.invalid' } as never
		const c1 = createNativeConetChatClient(config) as unknown as { request(cmd: Record<string, unknown>, ms?: number): Promise<unknown>; destroy?: () => void }
		const c2 = createNativeConetChatClient(config) as unknown as { request(cmd: Record<string, unknown>, ms?: number): Promise<unknown>; destroy?: () => void }
		void c1.request({ type: 'a' }, 50).catch(() => undefined)
		void c2.request({ type: 'b' }, 50).catch(() => undefined)
		void c1.request({ type: 'c' }, 50).catch(() => undefined)
		const ids = sent.map((c) => c.reqId as number)
		expect(new Set(ids).size).toBe(ids.length)
		expect(ids.every((n) => n > CHAT_TRANSPORT_REQ_BASE && n < CHAT_TRANSPORT_REQ_LIMIT)).toBe(true)
		c1.destroy?.()
		c2.destroy?.()
	})
})

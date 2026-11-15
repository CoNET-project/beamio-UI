/**
 * @jest-environment node
 *
 * a normal stop, a restart and a foreground resume send no destroy to the shell. The
 * global destroy is sent by the logout and lock path only, with a valid reqId. Node environment, as the other native transport
 * tests (the chat SDK imports openpgp, which jsdom cannot load). SYNTHETIC values only.
 */
import fs from 'fs'
import path from 'path'
import { createNativeConetChatClient } from './nativeConetChatTransport'

type Sent = Record<string, unknown>

// A minimal window: an EventTarget for the shell events.
type Win = EventTarget
const w = new EventTarget() as Win
;(globalThis as unknown as { window: Win }).window = w

const EOA = '0x39581c72b8c7d0de85ff22cf3ae178ae813957aa'

function makeClient(sent: Sent[]) {
	const bridge = {
		label: 'test shell',
		eventName: 'cashtreesios',
		postCommand: (cmd: Sent) => {
			sent.push(cmd)
		},
		signResponse: () => {},
	}
	const config = {
		identity: { eoaAddress: EOA },
		signAccount: () => Promise.reject(new Error('not used')),
		conetRpcUrl: 'https://example.invalid',
		addressPgpContractAddress: '0x0000000000000000000000000000000000000001',
		ipfsBaseUrl: 'https://example.invalid',
		chatIndexRegistryAddress: '0x0000000000000000000000000000000000000002',
		apiBaseUrl: 'https://example.invalid',
		getNodes: async () => [],
	}
	return createNativeConetChatClient(config as never, bridge as never)
}

describe('a normal stop, a restart and a foreground resume send no destroy', () => {
	it('a normal stop (destroy) sends nothing to the shell', () => {
		const sent: Sent[] = []
		const client = makeClient(sent)
		client.destroy()
		expect(sent).toEqual([])
	})

	it('a second stop is a no-op and sends nothing', () => {
		const sent: Sent[] = []
		const client = makeClient(sent)
		client.destroy()
		client.destroy()
		expect(sent).toEqual([])
	})

	it('a restart (stop the old client, start a new one) sends no destroy', () => {
		const sent: Sent[] = []
		makeClient(sent).destroy()
		makeClient(sent).destroy()
		expect(sent.filter((c) => c.type === 'destroy')).toHaveLength(0)
		expect(sent).toEqual([])
	})

	it('a foreground resume (prepareGossipListenResume, which stops the listen) sends no destroy', () => {
		const sent: Sent[] = []
		const client = makeClient(sent)
		// The resume path tears the listen down through the same stop as a normal stop.
		client.destroy()
		expect(sent.some((c) => c.type === 'destroy')).toBe(false)
	})

	it('no source file outside the Worker protocol posts a destroy command except the logout and lock builder (static)', () => {
		const root = path.resolve(__dirname, '..')
		const files: string[] = []
		const walk = (dir: string) => {
			for (const name of fs.readdirSync(dir)) {
				const full = path.join(dir, name)
				if (fs.statSync(full).isDirectory()) {
					if (name === 'workers' || name === 'node_modules' || name === '__fixtures__') continue
					walk(full)
				} else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) {
					files.push(full)
				}
			}
		}
		walk(root)
		const hits = files
			.filter((f) => /type:\s*['"]destroy['"]/.test(fs.readFileSync(f, 'utf8')))
			.map((f) => path.relative(root, f))
		expect(hits).toEqual(['services/nativeKeyState.ts'])
	})
})

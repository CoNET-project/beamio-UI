/**
 * @jest-environment node
 *
 * Shell build (REACT_APP_SHELL_BUILD=true) must keep the native chat listen reachable and remove only the browser
 * worker path. Reads the sources, so a moved or removed guard fails.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8')
const SHELL_GUARD_BROWSER_ONLY = "if (process.env.REACT_APP_SHELL_BUILD !== 'true')"

describe('shell build keeps the native listen', () => {
	it('the iOS and Android native clients are created before the shell-build guard of the browser branch', () => {
		const src = read('src/services/chatWorkerBridge.ts')
		const ios = src.indexOf('client = createNativeConetChatClient(config)')
		const android = src.indexOf('client = createAndroidNativeChatClient(config)')
		// The browser-branch guard is the build-time shell check that precedes the browser client (the incoming wording).
		const guard = src.indexOf("if (process.env.REACT_APP_SHELL_BUILD === 'true') {\n\t\t\tthrow new Error('shell build: the TypeScript gossip client is not part of the shell target')")
		expect(ios).toBeGreaterThan(0)
		expect(android).toBeGreaterThan(0)
		expect(guard).toBeGreaterThan(android)
	})

	it('the listen entry points carry no shell-build early return', () => {
		const bridge = read('src/services/chatWorkerBridge.ts')
		const start = bridge.indexOf('export const startWorkerGossipListen = async')
		expect(start).toBeGreaterThan(0)
		expect(bridge.slice(start, start + 400)).not.toContain('REACT_APP_SHELL_BUILD')
		const chat = read('src/services/chat.ts')
		const connect = chat.indexOf('export const connectToGossipNode = async')
		expect(connect).toBeGreaterThan(0)
		expect(chat.slice(connect, connect + 700)).not.toContain('REACT_APP_SHELL_BUILD')
	})

	it('the browser worker is referenced only inside the browser-only branch', () => {
		const src = read('src/services/chatWorkerBridge.ts')
		const fn = src.indexOf('function makeGossipWorker(): Worker {')
		expect(fn).toBeGreaterThan(0)
		const body = src.slice(fn, fn + 900)
		expect(body.indexOf(SHELL_GUARD_BROWSER_ONLY)).toBeGreaterThan(0)
		expect(body.indexOf('new Worker(')).toBeGreaterThan(body.indexOf(SHELL_GUARD_BROWSER_ONLY))
	})
})

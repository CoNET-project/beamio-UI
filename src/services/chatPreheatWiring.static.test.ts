/**
 * Wiring check (sdk-roles-chat-preheat.v1; v248 items 1-3): the App starts the browser preheat at account-ready without awaiting it
 * (before the account-info read) with the worker start and the tail completion; the unlock callback records the SDK unlock; sendMessage
 * and the decrypted-history read pass the passcode gate; chat.tsx joins the in-flight preheat before its local read.
 * The *_PATH variables point at other copies (used for the reverse control on the base commit).
 */
import * as fs from 'fs'
import * as path from 'path'

const at = (env: string, rel: string) => process.env[env] || path.resolve(__dirname, rel)
const appPath = at('PREHEAT_APP_PATH', '../App.tsx')
const unlockPath = at('PREHEAT_UNLOCK_PATH', 'unlockChatRestart.ts')
const chatPath = at('PREHEAT_CHAT_PATH', 'chat.ts')
const bridgePath = at('PREHEAT_BRIDGE_PATH', 'chatWorkerBridge.ts')
const chatTsxPath = at('PREHEAT_CHATTSX_PATH', '../pages/chat/chat.tsx')

describe('chat preheat is wired (SDR-08, SDR-09, SDR-12..14)', () => {
	const app = fs.readFileSync(appPath, 'utf8')
	it('App imports startChatPreheat and calls it without await, with the browser gate, the worker start and the tail completion', () => {
		expect(app).toMatch(/import \{ startChatPreheat \} from "@\/services\/chatPreheat"/)
		expect(app).toMatch(/void startChatPreheat\(\{/)
		expect(app).not.toMatch(/await startChatPreheat/)
		expect(app).toMatch(/shell: isShellContext\(\),/)
		expect(app).toMatch(/startWorker: \(\) => initChat\(/)
		expect(app).toMatch(/awaitHistoryTail: \(\) => awaitWorkerHistoryTail\(\)/)
	})
	it('the preheat call comes before the account-info read (it is not behind it)', () => {
		const pos = app.indexOf('void startChatPreheat({')
		const read = app.indexOf('const loaded = await loadUserInfoWithBackoff(')
		expect(pos).toBeGreaterThan(0)
		expect(read).toBeGreaterThan(pos)
	})
	it('sendMessage passes the UI chat access guard before any send work (unit e)', () => {
		const chat = fs.readFileSync(chatPath, 'utf8')
		const fn = chat.indexOf('export const sendMessage = async (')
		const gate = chat.indexOf("chatAccessRefused('send')")
		expect(fn).toBeGreaterThan(0)
		expect(gate).toBeGreaterThan(fn)
		expect(gate - fn).toBeLessThan(800)
	})
	it('the decrypted-history read passes the passcode gate and the bridge exposes the tail completion', () => {
		const bridge = fs.readFileSync(bridgePath, 'utf8')
		const fn = bridge.indexOf('export const readDecryptedChatHistory')
		const gate = bridge.indexOf("chatAccessRefused('history_read')")
		expect(gate).toBeGreaterThan(fn)
		expect(bridge).toMatch(/historyTail\.noteTail\(client, batch\?\.isTail\)/)
		expect(bridge).toMatch(/export const awaitWorkerHistoryTail/)
	})
	it('chat.tsx joins the in-flight preheat before its local read', () => {
		const tsx = fs.readFileSync(chatTsxPath, 'utf8')
		const join = tsx.indexOf("if (chatPreheatState() === 'requested') await awaitChatPreheat()")
		const read = tsx.indexOf('await openLocalChatPage(address, viewport)')
		expect(join).toBeGreaterThan(0)
		expect(read).toBeGreaterThan(join)
	})
})

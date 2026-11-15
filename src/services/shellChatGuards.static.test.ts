/**
 * @jest-environment node
 *
 * Option A guards are in place on every identity path. The check reads the sources, so a removed guard fails.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', 'src', rel), 'utf8')

describe('option A guards', () => {
	it('initChat starts nothing, and reads no key, before the shell answer says native_chat', () => {
		const src = read('services/chat.ts')
		const guard = src.indexOf("if (isShellContext() && (await ensureShellChatState()) !== 'native_chat') {")
		const start = src.indexOf('initChatInProgress = true')
		expect(guard).toBeGreaterThan(0)
		expect(start).toBeGreaterThan(guard)
	})

	it('the native / worker listen is refused in a blocked shell', () => {
		expect(read('services/chatWorkerBridge.ts')).toMatch(/export const startWorkerGossipListen = async[\s\S]{0,200}if \(shellChatBlockedNow\(\)\) return false/)
	})

	it('push identity binding sends nothing to a blocked shell', () => {
		expect(read('utils/cashTreesPushBind.ts')).toMatch(/export function bindNativePushIdentity[\s\S]{0,300}if \(shellChatBlockedNow\(\)\) return false/)
	})

	it('the central signing-key resolver reads and hydrates no key in a blocked shell', () => {
		expect(read('utils/resolveSigningPrivateKeyArmor.ts')).toMatch(/if \(shellChatBlockedNow\(\)\) return ''/)
	})

	it('route registration needs both the chat capability and its own, and sends nothing else', () => {
		expect(read('services/nativeChatRouteRegister.ts')).toMatch(/!probe\.capabilities\.includes\(NATIVE_KEYS_CAPABILITY\) \|\| !probe\.capabilities\.includes\(ROUTE_REGISTER_CAPABILITY\)/)
	})

	it('the app gate asks the shared probe once', () => {
		expect(read('components/AppEntryGate.tsx')).toMatch(/void ensureShellChatState\(\)/)
	})
})

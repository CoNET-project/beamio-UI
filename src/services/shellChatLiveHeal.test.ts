/**
 * @jest-environment node
 */
// after the chat was listening in the same session the identity prompt "The native wallet is not ready yet" still came on every press, "Try again" changed nothing,
// and the list appeared only after a cold start. A live native chat now keeps the chat UI state at native_chat, heals it when a blocked check finds it otherwise, and the retry
// asks the chat start again. SYNTHETIC.
jest.mock('@/services/shellContext', () => ({ isShellContext: () => true }))
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: jest.fn() }))
jest.mock('@/utils/shellBuildFlag', () => ({ isShellBuildKind: () => true }))
jest.mock('@/utils/cashTreesNativeNfc', () => ({ isCashTreesNativeWebView: () => true, getCashTreesNativeNfcHost: () => null }))
jest.mock('@/locale/beamioLocale', () => ({ tu: (k: string) => k }))
jest.mock('@/services/nativeChatRouteRegister', () => ({ onHelloValid: () => () => undefined, probeNativeCapabilities: async () => ({ answered: false, capabilities: [] }) }))

import fs from 'fs'
import path from 'path'
import { getShellChatUiState, setShellChatUiState } from './shellChatUiState'
import { setShellChatLive, isShellChatLive } from './shellChatLive'
import { shellChatBlockedNow, ensureShellChatState } from './shellChatCapability'

beforeEach(() => {
	setShellChatLive(false)
	setShellChatUiState('chat_unavailable', 'test_reset')
})

describe('the chat UI state while the native chat is live', () => {
	it('not live: every writer works as before', () => {
		setShellChatUiState('native_chat', 't')
		setShellChatUiState('identity_pending', 't')
		expect(getShellChatUiState()).toBe('identity_pending')
	})
	it('live: a notice state does not replace native_chat (the write is refused)', () => {
		setShellChatUiState('native_chat', 't')
		setShellChatLive(true)
		setShellChatUiState('identity_pending', 'first_identity_event')
		setShellChatUiState('chat_unavailable', 'start_chat_unavailable')
		expect(getShellChatUiState()).toBe('native_chat')
	})
	it('live: a write TO native_chat always works', () => {
		setShellChatLive(true)
		setShellChatUiState('native_chat', 't')
		expect(getShellChatUiState()).toBe('native_chat')
	})
	it('the blocked check heals a notice state left behind while the chat is live, and does not block the press', () => {
		setShellChatUiState('identity_pending', 'earlier_start')
		expect(shellChatBlockedNow()).toBe(true) // not live: blocked, as before
		setShellChatLive(true)
		expect(shellChatBlockedNow()).toBe(false)
		expect(getShellChatUiState()).toBe('native_chat')
	})
	it('not live: the blocked check never heals (a shell without the chat stays blocked)', () => {
		setShellChatUiState('chat_unavailable', 't')
		expect(shellChatBlockedNow()).toBe(true)
		expect(getShellChatUiState()).toBe('chat_unavailable')
		expect(isShellChatLive()).toBe(false)
	})
})

describe('the wiring (static)', () => {
	const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8')
	it('chat.ts marks the chat live when a start ends started, and not live when the session is cleared or the start ends otherwise', () => {
		const chat = read('chat.ts')
		expect(chat).toMatch(/lastShellStartResult = result\n\t+\/\/[^\n]*\n\t+setShellChatLive\(result === 'started'\)/)
		expect(chat).toMatch(/const clearGossipListenSession = \(reason: string\) => \{\n\tsetShellChatLive\(false\)/)
	})
	it('the logout teardown clears it', () => {
		expect(read('nativeKeyState.ts')).toMatch(/forgetNativeSessionReady\(\)\n\tsetShellChatLive\(false\)/)
	})
	it('every writer names itself in the log', () => {
		for (const f of ['chat.ts', 'shellChatCapability.ts']) {
			const src = read(f)
			for (const m of src.matchAll(/setShellChatUiState\(([^)\n]*)\)/g)) if (!/^[^,]+, '/.test(m[1])) expect(`${f}: ${m[0]}`).toBe('a call with a reason')
		}
	})
	it('the "Try again" retry also asks the chat start to read the identity again', () => {
		const gate = fs.readFileSync(path.join(__dirname, '../components/AppEntryGate.tsx'), 'utf8')
		expect(gate).toMatch(/onNativeIdentityRetryRequested\(\(\) => \{[\s\S]*?void initRef\.current\?\.\(\)[\s\S]*?requestShellRetryNow\(\)/)
	})
})

describe('asking again never closes a chat state that was already opened (the AppEntryGate re-entry, 3.5 s after the start, in both iOS slices)', () => {
	it('an unanswered re-ask leaves native_chat as it is (no chat_unavailable written, then no chat_unavailable from the probe)', async () => {
		setShellChatUiState('native_chat', 'earlier_answer')
		await ensureShellChatState()
		expect(getShellChatUiState()).toBe('native_chat')
	})
})


/**
 * the Android running check in shouldResumeGossipListen (chat.ts) counts the chat module through either channel,
 * window.BeamioChat or the legacy CashTreesAndroid.chatModuleCommand. The running answer itself is unchanged. SYNTHETIC values.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { androidChatModulePresent } from './androidChatChannel'

const w = window as unknown as { BeamioChat?: unknown; CashTreesAndroid?: unknown }

afterEach(() => {
	delete w.BeamioChat
	delete w.CashTreesAndroid
})

describe('androidChatModulePresent: presence through either channel', () => {
	it('window.BeamioChat alone: present', () => {
		w.BeamioChat = { postMessage: () => undefined }
		expect(androidChatModulePresent()).toBe(true)
	})

	it('the legacy chatModuleCommand alone: present', () => {
		w.CashTreesAndroid = { chatModuleCommand: () => undefined }
		expect(androidChatModulePresent()).toBe(true)
	})

	it('both channels: present', () => {
		w.BeamioChat = { postMessage: () => undefined }
		w.CashTreesAndroid = { chatModuleCommand: () => undefined }
		expect(androidChatModulePresent()).toBe(true)
	})

	it('a shell with neither chat channel (only the listen-only host): not present', () => {
		w.CashTreesAndroid = { conetChatAvailable: () => true }
		expect(androidChatModulePresent()).toBe(false)
	})

	it('no shell: not present', () => {
		expect(androidChatModulePresent()).toBe(false)
	})
})

describe('shouldResumeGossipListen wiring (chat.ts)', () => {
	const chat = readFileSync(join(__dirname, '..', 'services', 'chat.ts'), 'utf8')

	it('the running check uses androidChatModulePresent(), not the legacy-only availability', () => {
		expect(chat).toContain('if (androidChatModulePresent() && isCashTreesAndroidChatModuleRunning()) return false')
		expect(chat).not.toContain('isCashTreesAndroidChatModuleAvailable')
	})
})

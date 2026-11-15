/**
 * Sign Out path (acceptance, r3): lock the library, clear the in-memory bodies, tell the chat page.
 * Tested on the core with injected dependencies (synthetic profile only). The production wiring is the same core
 * called with the real lock, the real profile and the window event.
 */
import { CHAT_LOCKED_EVENT, lockChatLocalCore } from './chatLocalMigrationCore'

describe('Sign Out: lock path', () => {
	function fixture(lockResult: boolean | Error) {
		const profiles = [{ chats: [{ messages: [{ id: 'm1', text: 'synthetic' }, { id: 'm2', text: 'synthetic' }] }] }]
		const calls: string[] = []
		const deps = {
			lockWorker: async () => {
				calls.push('lock')
				if (lockResult instanceof Error) throw lockResult
				return lockResult
			},
			clearInMemoryBodies: () => {
				calls.push('clear')
				for (const p of profiles) for (const c of p.chats) c.messages = []
			},
			notifyChatPage: () => calls.push('notify'),
		}
		return { deps, profiles, calls }
	}

	it('locks first, then clears the bodies, then notifies the chat page', async () => {
		const f = fixture(true)
		expect(await lockChatLocalCore(f.deps)).toBe(true)
		expect(f.calls).toEqual(['lock', 'clear', 'notify'])
		expect(f.profiles[0].chats[0].messages).toEqual([])
	})

	it('a failing worker lock still clears the page and reports failure', async () => {
		const f = fixture(new Error('worker_unavailable'))
		expect(await lockChatLocalCore(f.deps)).toBe(false)
		expect(f.profiles[0].chats[0].messages).toEqual([])
		expect(f.calls).toEqual(['lock', 'clear', 'notify'])
	})

	it('the chat-locked event name is the one the chat page listens to', () => {
		expect(CHAT_LOCKED_EVENT).toBe('beamio:chat-locked')
	})
})

/**
 * @jest-environment node
 *
 * The daemon provider drops its profile key copy when the page-session key is dropped (static check of the source).
 */
import { readFileSync } from 'fs'
import { join } from 'path'

describe('the profile state drops its key copy with the page-session key', () => {
	const src = readFileSync(join(__dirname, '..', 'providers', 'DaemonProvider.tsx'), 'utf8')

	it('listens for the cleared event and removes the key from the profile state', () => {
		expect(src).toContain('SHELL_SESSION_KEY_CLEARED_EVENT')
		expect(src).toContain("window.addEventListener(SHELL_SESSION_KEY_CLEARED_EVENT, onKeyCleared)")
		expect(src).toContain("privateKeyArmor: '' }")
	})

	it('the event is dispatched only by the session module when a key was held', () => {
		const sess = readFileSync(join(__dirname, 'shellSessionSigner.ts'), 'utf8')
		expect(sess).toContain('window.dispatchEvent(new Event(SHELL_SESSION_KEY_CLEARED_EVENT))')
	})
})

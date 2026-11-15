/**
 * @jest-environment node
 *
 * Dropping the page-session key tells the page state to drop its copy (the window event). Public zero-entropy vector only.
 */
// The module reads `window` when it loads (for the page-unload hook), so the stand-in window is set first.
;(globalThis as { window?: unknown }).window = new EventTarget()
// eslint-disable-next-line @typescript-eslint/no-var-requires
const session = require('./shellSessionSigner') as typeof import('./shellSessionSigner')

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'

describe('dropping the page-session key', () => {
	beforeEach(() => session.clearShellSessionSigner())

	it('a held key is dropped with one window event', () => {
		const onCleared = jest.fn()
		;(globalThis as { window: EventTarget }).window.addEventListener(session.SHELL_SESSION_KEY_CLEARED_EVENT, onCleared)
		expect(session.holdShellSessionFromPhrase(PHRASE, EOA)).toEqual({ kind: 'ok' })
		session.clearShellSessionSigner()
		expect(onCleared).toHaveBeenCalledTimes(1)
		expect(session.shellSessionPrivateKeyFor(EOA)).toBe('')
	})

	it('nothing held: no event, and a second clear is silent', () => {
		const onCleared = jest.fn()
		;(globalThis as { window: EventTarget }).window.addEventListener(session.SHELL_SESSION_KEY_CLEARED_EVENT, onCleared)
		session.clearShellSessionSigner()
		session.holdShellSessionFromPhrase(PHRASE, EOA)
		session.clearShellSessionSigner()
		session.clearShellSessionSigner()
		expect(onCleared).toHaveBeenCalledTimes(1)
	})
})

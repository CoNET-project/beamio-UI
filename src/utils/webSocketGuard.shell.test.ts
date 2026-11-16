/**
 * Shell-owned WebSocket property (document start). A native guard may define WebSocket as non-writable and
 * non-configurable before the page runs. This module must not throw, must not overwrite it, must not report it as its own
 * refusal, and must not trust a page-set flag to skip anything.
 */
describe('WebSocket guard when a shell owns a non-configurable WebSocket', () => {
	const g = globalThis as any

	afterEach(() => {
		jest.resetModules()
	})

	it('keeps the shell-defined constructor, does not throw, and reports it as not installed by this module', () => {
		const shellStub = function ShellWebSocket() {
			throw new Error('shell_refused')
		}
		Object.defineProperty(g, 'WebSocket', { value: shellStub, writable: false, configurable: false, enumerable: false })
		let mod: typeof import('./webSocketGuard') | undefined
		expect(() => {
			jest.isolateModules(() => {
				mod = require('./webSocketGuard')
			})
		}).not.toThrow()
		expect(g.WebSocket).toBe(shellStub)
		expect(mod!.webSocketGuardStatus()).toBe('not_installed_non_configurable')
		expect(mod!.webSocketConstructorIsRefused()).toBe(false)
	})

	it('does not trust a page-set shell flag: the flag changes nothing and reports only as informational', () => {
		const shellStub = g.WebSocket
		Object.defineProperty(g, '__beamioWsGuard', { value: true, configurable: true })
		let mod: typeof import('./webSocketGuard') | undefined
		jest.isolateModules(() => {
			mod = require('./webSocketGuard')
		})
		expect(g.WebSocket).toBe(shellStub)
		expect(mod!.shellGuardDeclared()).toBe(true)
		expect(mod!.webSocketConstructorIsRefused()).toBe(false)
	})
})

/**
 * WebSocket refusal (AGENTS.md, project rule: no WebSocket in this project).
 *
 * Installs a refusing global `WebSocket` constructor. It is imported first by the entry (src/index.tsx), by every
 * worker entry under src/workers, and by the standalone pages' <head> script. Modules that capture the global
 * constructor when they are evaluated (the vendored ethers, the npm ethers browser build) therefore see the refusal.
 *
 * The guard never trusts a flag set by page script: it installs whenever the property is writable or configurable.
 * Where the property is already non-configurable (a native shell guard installed at document start), it is left as it is,
 * and the status says so; that status is an observation, not proof that the shell guard refuses.
 *
 * The library code that contains WebSocket classes stays in the artifact. This module refuses calls at runtime; it does
 * not delete the code and is not proof that the code is unreachable.
 */

export const WEBSOCKET_REFUSAL = 'websocket_disabled_by_project_rule'

/** Flag a shell's document-start guard may set. Informational only: it never disables this guard. */
export const SHELL_WS_GUARD_FLAG = '__beamioWsGuard'

/** Count of refused constructions in this context (no URL is kept). */
let refusedCount = 0
export const webSocketRefusedCount = (): number => refusedCount

class RefusedWebSocket {
	constructor() {
		refusedCount += 1
		throw new Error(WEBSOCKET_REFUSAL)
	}
}

export type WebSocketGuardStatus = 'installed' | 'already_installed' | 'not_installed_non_configurable'

const scope = globalThis as unknown as Record<string, unknown>
let status: WebSocketGuardStatus = 'not_installed_non_configurable'

const install = (): void => {
	if (scope.WebSocket === RefusedWebSocket) {
		status = 'already_installed'
		return
	}
	try {
		Object.defineProperty(scope, 'WebSocket', {
			value: RefusedWebSocket,
			writable: false,
			configurable: false,
			enumerable: false,
		})
		status = 'installed'
	} catch {
		// Non-configurable and not ours: a shell guard owns the property. Never overwritten, never an error.
		status = 'not_installed_non_configurable'
	}
}

install()

/** The outcome of this context's install attempt. */
export const webSocketGuardStatus = (): WebSocketGuardStatus => status

/** True only when this module's own refusal is the global constructor (not a shell's). */
export const webSocketConstructorIsRefused = (): boolean => scope.WebSocket === RefusedWebSocket

/** Informational: a shell guard declared itself via the flag. It does not change what this module does. */
export const shellGuardDeclared = (): boolean => scope[SHELL_WS_GUARD_FLAG] === true

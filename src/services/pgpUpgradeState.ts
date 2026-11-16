/**
 * `pgpUpgradeState` (spec r3rz §25.52Y.62, item 5). The SDK sends `{type: "pgpUpgradeState", code}` only: no reqId, no key,
 * account or backup content. The page keeps the last code and shows the non-blocking migration retry notice for
 * `pgp_migration_retry` only. The other four codes are recorded and change no screen; unknown codes are ignored.
 * Internal failures reach the page as `pgp_migration_retry` (the SDK never sends a cause code).
 */
import { NATIVE_EVENT_NAMES, eventPayloadOf } from './nativeKeyState'

export const PGP_UPGRADE_STATE_EVENT = 'pgpUpgradeState'
export const PGP_UPGRADE_STATE_CODES = [
	'upgraded_from_L',
	'upgraded_from_chain',
	'keep_existing',
	'generated_on_user_click',
	'pgp_migration_retry',
] as const
export type PgpUpgradeStateCode = (typeof PGP_UPGRADE_STATE_CODES)[number]

/**
 * Accepts only an event with exactly the fields type and code, the type matching and the code known. Anything else is null
 * (ignored): an extra field, a reqId, or an unknown code never changes the page.
 */
export function parsePgpUpgradeStateEvent(payload: unknown): PgpUpgradeStateCode | null {
	if (!payload || typeof payload !== 'object') return null
	const o = payload as Record<string, unknown>
	if (o.type !== PGP_UPGRADE_STATE_EVENT) return null
	for (const k of Object.keys(o)) if (k !== 'type' && k !== 'code') return null
	const code = o.code
	if (typeof code !== 'string') return null
	return (PGP_UPGRADE_STATE_CODES as readonly string[]).includes(code) ? (code as PgpUpgradeStateCode) : null
}

let lastCode: PgpUpgradeStateCode | null = null
const listeners = new Set<(code: PgpUpgradeStateCode) => void>()

/** The last recorded code (for a page that mounts after the event). */
export function getPgpUpgradeState(): PgpUpgradeStateCode | null {
	return lastCode
}

/** True when the notice must show: only the retry code shows it. */
export function pgpUpgradeRetryVisible(): boolean {
	return lastCode === 'pgp_migration_retry'
}

export function subscribePgpUpgradeState(listener: (code: PgpUpgradeStateCode) => void): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

function record(code: PgpUpgradeStateCode): void {
	lastCode = code
	for (const l of listeners) l(code)
}

let installed = false
/** Installs the window listener once per context. */
export function installPgpUpgradeStateListener(): void {
	if (installed || typeof window === 'undefined') return
	installed = true
	const handler = (ev: Event) => {
		const code = parsePgpUpgradeStateEvent(eventPayloadOf(ev))
		if (code) record(code)
	}
	for (const name of NATIVE_EVENT_NAMES) window.addEventListener(name, handler)
}

/** Test-only reset. */
export function resetPgpUpgradeStateForTest(): void {
	lastCode = null
	listeners.clear()
}

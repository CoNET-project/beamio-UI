/**
 * Orchestration for the chat plaintext purge.
 *
 * Pure orchestration with injected dependencies: the production wiring lives in chatLocalMigration.ts.
 * Order is strict: read-back (done in the worker, state complete) → switch (state switched) → purge.
 * The purge writes the profile first and verifies it by reading it back. Only then is the worker's plaintext purged.
 * Any failure restores the in-memory profiles and the stored copy from the original objects, which are never mutated.
 */
import { countChatMessages, markChatBodiesPurged, nonChatFingerprint, profileEoaOf, stripChatBodiesFromProfiles } from './chatLocalPurge'

export interface MigrationDeps {
	/** Worker migration state: none, running, complete, switched or purged. */
	workerState(): Promise<string>
	/**  (worker): switch the UI to the library. Returns false when refused. */
	workerSwitch(): Promise<boolean>
	/**  worker part: delete plain: keys. Returns the number removed. Throws on failure. */
	workerPurge(): Promise<number>
	/** Current in-memory profiles (the live objects; they are never mutated by this module). */
	liveProfiles(): unknown[]
	/** Replace the in-memory profiles. */
	setLiveProfiles(profiles: unknown[]): void
	/** Persist the in-memory profiles (PouchDB and the Cache API copy). Resolves false on failure. */
	persistProfiles(): Promise<boolean>
	/** Read the stored profiles back from storage. Null when unreadable. */
	readStoredProfiles(): Promise<unknown[] | null>
	/** Set the per-account purged flag (after the worker purge succeeded). */
	markPurged(eoa: string): void
}

export type MigrationResult = { ok: true; purged: number; alreadyPurged: boolean } | { ok: false; reason: string }

export async function runMigrationCore(deps: MigrationDeps): Promise<MigrationResult> {
	let state = await deps.workerState()
	if (state === 'purged') {
		// the flag is a cache of this state, written after the purge and not durable at a kill. Every start that sees `purged`
		// puts it back, so profilesForPersist (strip bodies) and the floor (keepMessages) agree with the library again. Never the other way round: the flag's absence says nothing about the library.
		const eoaPurged = profileEoaOf(deps.liveProfiles())
		if (eoaPurged && countChatMessages(deps.liveProfiles()) === 0) deps.markPurged(eoaPurged) // only while no body is left in memory (see chatLocalMigration.ts)
		return { ok: true, purged: 0, alreadyPurged: true }
	}
	if (state === 'complete') {
		//  read-back has passed (state complete).  switches the UI to the library.
		if (!(await deps.workerSwitch())) return { ok: false, reason: 'switch_refused' }
		state = 'switched'
	}
	if (state !== 'switched') return { ok: false, reason: `precondition_state_${state}` }

	const original = deps.liveProfiles()
	const eoa = profileEoaOf(original)
	const fingerprintBefore = nonChatFingerprint(original)
	try {
		deps.setLiveProfiles(stripChatBodiesFromProfiles(original))
		if (!(await deps.persistProfiles())) throw new Error('persist_failed')
		const stored = await deps.readStoredProfiles()
		if (!stored) throw new Error('readback_missing')
		if (nonChatFingerprint(stored) !== fingerprintBefore) throw new Error('fingerprint_mismatch')
		if (countChatMessages(stored) !== 0) throw new Error('bodies_remain')
		const purged = await deps.workerPurge()
		if (eoa) deps.markPurged(eoa)
		return { ok: true, purged, alreadyPurged: false }
	} catch (ex) {
		// Roll back: the original objects are still intact. Restore them in memory and in storage.
		deps.setLiveProfiles(original)
		try {
			await deps.persistProfiles()
		} catch {
			/* the next start retries  from state switched */
		}
		return { ok: false, reason: (ex as Error)?.message ?? String(ex) }
	}
}

/** Used by the app to mark an account as purged after a verified run (exported for tests). */
export function purgedFlagFor(profiles: unknown[]): void {
	const eoa = profileEoaOf(profiles)
	if (eoa) markChatBodiesPurged(eoa)
}

/** Window event the chat page listens to in order to clear its rendered messages. */
export const CHAT_LOCKED_EVENT = 'beamio:chat-locked'

export interface LogoutDeps {
	/** Lock the worker library (zeroes its subkeys; keeps the library file). Resolves false on failure. */
	lockWorker(): Promise<boolean>
	/** Drop in-memory message bodies from the profiles. */
	clearInMemoryBodies(): void
	/** Tell the open chat page to clear what it renders. */
	notifyChatPage(): void
}

/**
 * Sign Out path (acceptance, r3): the library is locked first, then the in-memory bodies and the
 * chat page are cleared. The order means a failed worker lock still clears the page.
 */
export async function lockChatLocalCore(deps: LogoutDeps): Promise<boolean> {
	let locked = false
	try {
		locked = await deps.lockWorker()
	} catch {
		locked = false
	}
	deps.clearInMemoryBodies()
	deps.notifyChatPage()
	return locked
}

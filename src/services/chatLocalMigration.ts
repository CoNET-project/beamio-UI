/**
 * Production wiring for the chat plaintext migration.
 *
 * Runs the import and the read-back in the worker (library import, digest check, sealed verified digest, reopened read-back), then
 * the switch and the purge (strip profile bodies, verify by read-back, purge plain: keys) through `runMigrationCore` in chatLocalMigrationCore.ts.
 * Single-flight: a second call while one run is in progress returns the same promise.
 */
import { CoNET_Data } from '@/utils/globals'
import { readStoredProfilesForVerify, storeSystemDataAndWait } from './beamio'
import {
	localChatLibraryCapable,
	localChatMigrationState,
	readDecryptedChatHistory,
	lockLocalChat,
	migrateLocalChatHistory,
	purgeLocalChatPlain,
	switchLocalChatHistory,
} from './chatWorkerBridge'
import { countChatMessages, markChatBodiesPurged, migrationExtraFromProfiles, noteLibraryEvidence, profileEoaOf, withExactRecordWrite } from './chatLocalPurge'
import { cleanRecordBodies, type CleanupDeps } from './recordBodyCleanup'
import { readLibraryStateBounded } from './senderCopy'
import { CHAT_LOCKED_EVENT, lockChatLocalCore, runMigrationCore, type MigrationDeps } from './chatLocalMigrationCore'

export type ChatLocalMigrationOutcome = 'no_profile' | 'already_purged' | 'import_not_verified' | 'purged' | `m7_failed:${string}`

let inFlight: Promise<ChatLocalMigrationOutcome> | null = null

function productionDeps(): MigrationDeps {
	return {
		workerState: async () => (await localChatMigrationState()) ?? 'none',
		workerSwitch: async () => (await switchLocalChatHistory()) === true,
		workerPurge: async () => {
			const removed = await purgeLocalChatPlain()
			if (removed === null) throw new Error('worker_unavailable')
			return removed
		},
		liveProfiles: () => ((CoNET_Data as { profiles?: unknown[] } | undefined)?.profiles ?? []) as unknown[],
		setLiveProfiles: (profiles) => {
			if (CoNET_Data) (CoNET_Data as { profiles?: unknown[] }).profiles = profiles
		},
		persistProfiles: () => storeSystemDataAndWait(),
		readStoredProfiles: () => readStoredProfilesForVerify(),
		markPurged: (eoa) => markChatBodiesPurged(eoa),
	}
}

/**
 * read the library's own state (bounded: a worker that does not answer in 5 s is "unknown") and hand it to the persistence rule (chatLocalPurge.ts libraryPersistModeFor), so that the account record and
 * the chats floor follow the library and not only the localStorage flag a SIGKILL can drop. A client without a library (a native shell) is recorded as not capable: it never counts as library mode.
 * A state that is unknown is asked again every 10 s (at most 30 times) so that the record does not stay in the cautious mode longer than the worker needs to answer.
 */
let evidenceRetry: ReturnType<typeof setTimeout> | null = null
let evidenceRetries = 0
/** The production wiring of the cleanup (recordBodyCleanup.ts): the library's own history read answers "does it hold this sendId", the write is an exact one (no floor bringing bodies back, no strip). */
function productionCleanupDeps(): CleanupDeps {
	return {
		liveProfiles: () => ((CoNET_Data as { profiles?: unknown[] } | undefined)?.profiles ?? []) as unknown[],
		setLiveProfiles: (profiles) => { if (CoNET_Data) (CoNET_Data as { profiles?: unknown[] }).profiles = profiles },
		libraryHas: async (peer, sendIds) => {
			const entries = await readDecryptedChatHistory({ peer, caller: 'recordBodyCleanup' }).catch(() => null)
			if (!entries) return null
			const have = new Set<string>()
			for (const e of entries) if (e.peer.toLowerCase() === peer && typeof e.sendId === 'string' && sendIds.includes(e.sendId)) have.add(e.sendId)
			return have
		},
		persistProfiles: () => withExactRecordWrite(() => storeSystemDataAndWait()),
		readStoredProfiles: () => readStoredProfilesForVerify(),
	}
}

/** An unknown read is asked again in 10 s, at most 30 times, one timer at a time. Called by every place that reads the state (migration start, the chat page's decisions). */
export function ensureLibraryEvidenceRetry(eoa: string): void {
	if (!eoa || evidenceRetry !== null || evidenceRetries >= 30) return
	evidenceRetries += 1
	evidenceRetry = setTimeout(() => {
		evidenceRetry = null
		void refreshLibraryEvidence(eoa)
	}, 10_000)
}

export async function refreshLibraryEvidence(eoa: string): Promise<string | null> {
	if (!eoa) return null
	const capable = localChatLibraryCapable()
	const state = capable ? await readLibraryStateBounded(localChatMigrationState) : null
	noteLibraryEvidence({ eoa, capable, state })
	if (capable && state === null) ensureLibraryEvidenceRetry(eoa)
	else evidenceRetries = 0
	return state
}

/**
 * when the chat worker is ready, the library's state is read AT ONCE, whether or not the wallet unlock that the migration needs
 * succeeds. An account whose localStorage flag was lost (SIGKILL) then moves from the startup default (`record`) to the mode its library says (`guarded` / `library`) as soon as the library can answer, instead of
 * waiting for the next send or receipt decision. An unknown answer is asked again every 10 s (ensureLibraryEvidenceRetry). Never throws.
 */
export function refreshEvidenceOnWorkerReady(): Promise<string | null> {
	const profiles = ((CoNET_Data as { profiles?: unknown[] } | undefined)?.profiles ?? []) as unknown[]
	const eoa = profileEoaOf(profiles)
	// the App-level history restore and this read run in parallel, and the 200 ms debounced record write can run BEFORE the read answers (up to the 5 s bound). With no evidence yet
	// that write judges the account `record` and writes the whole restored history as plaintext into the record. So, SYNCHRONOUSLY and before the async read starts: a client with a library exists and its state is unknown
	// => `guarded` (no new bodies in the record; stored ones are kept). A state that is already known for this account is never overwritten by this unknown (noteLibraryEvidence). The default of an account with no library client stays `record`.
	if (eoa && localChatLibraryCapable()) noteLibraryEvidence({ eoa, capable: true, state: null })
	return refreshLibraryEvidence(eoa).catch(() => null)
}

async function runOnce(): Promise<ChatLocalMigrationOutcome> {
	const out = await runOnceInner()
	// the outcome may have changed the state (switched, purged): the persistence rule follows it
	const profiles = ((CoNET_Data as { profiles?: unknown[] } | undefined)?.profiles ?? []) as unknown[]
	await refreshLibraryEvidence(profileEoaOf(profiles)).catch(() => null)
	return out
}

async function runOnceInner(): Promise<ChatLocalMigrationOutcome> {
	const profiles = ((CoNET_Data as { profiles?: unknown[] } | undefined)?.profiles ?? []) as unknown[]
	if (!profiles.length) return 'no_profile'
	const state = (await refreshLibraryEvidence(profileEoaOf(profiles))) ?? 'none'
	if (state === 'purged') {
		// the library says purged: put a lost localStorage flag back (a SIGKILL drops it; profilesForPersist and the chats floor read it). Only ever set from the library's state, never cleared from its absence.
		// Only while the record holds no bodies: a body written back after the flag was lost may be the only copy of that message, and with the flag the floor would drop it. Those stay (guarded mode) until the library confirms them.
		const eoaPurged = profileEoaOf(profiles)
		// bodies that are still in the record (written back after the flag was lost) are removed one by one, only after the library confirms it holds them (recordBodyCleanup.ts); the flag comes back when none is left
		let bodiesLeft = countChatMessages(profiles)
		if (bodiesLeft > 0 && localChatLibraryCapable()) {
			await cleanRecordBodies(productionCleanupDeps()).catch(() => null)
			bodiesLeft = countChatMessages(((CoNET_Data as { profiles?: unknown[] } | undefined)?.profiles ?? []) as unknown[])
		}
		if (eoaPurged && bodiesLeft === 0) markChatBodiesPurged(eoaPurged)
		return 'already_purged'
	}
	if (state !== 'complete' && state !== 'switched') {
		// Import the manifest rows and the profile copies; verify; read back on a reopened library
		const res = await migrateLocalChatHistory(migrationExtraFromProfiles(profiles))
		if (!res?.verified) return 'import_not_verified'
	}
	const purge = await runMigrationCore(productionDeps())
	if (!purge.ok) return `m7_failed:${purge.reason}`
	return purge.alreadyPurged ? 'already_purged' : 'purged'
}

/** Run the migration once for the active account. Safe to call repeatedly. */
export function runChatLocalMigration(): Promise<ChatLocalMigrationOutcome> {
	if (!inFlight) {
		inFlight = runOnce().finally(() => {
			inFlight = null
		})
	}
	return inFlight
}

/** Event name the chat page listens to in order to clear its rendered messages. */
export { CHAT_LOCKED_EVENT }

/**
 * Sign Out: lock the library, clear the in-memory bodies, and tell the chat page to clear.
 * The sign-out row calls this; the logic lives in lockChatLocalCore, which is tested without the app imports.
 */
export function lockChatLocalOnLogout(): Promise<boolean> {
	return lockChatLocalCore({
		lockWorker: () => lockLocalChat(),
		clearInMemoryBodies: () => {
			const profiles = (CoNET_Data as { profiles?: Array<{ chats?: Array<{ messages?: unknown[] }> }> } | undefined)?.profiles
			for (const p of profiles ?? []) for (const c of p?.chats ?? []) if (c) c.messages = []
		},
		notifyChatPage: () => {
			if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHAT_LOCKED_EVENT))
		},
	})
}

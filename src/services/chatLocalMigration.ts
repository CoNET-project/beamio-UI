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
	localChatMigrationState,
	lockLocalChat,
	migrateLocalChatHistory,
	purgeLocalChatPlain,
	switchLocalChatHistory,
} from './chatWorkerBridge'
import { markChatBodiesPurged, migrationExtraFromProfiles } from './chatLocalPurge'
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

async function runOnce(): Promise<ChatLocalMigrationOutcome> {
	const profiles = ((CoNET_Data as { profiles?: unknown[] } | undefined)?.profiles ?? []) as unknown[]
	if (!profiles.length) return 'no_profile'
	const state = (await localChatMigrationState()) ?? 'none'
	if (state === 'purged') return 'already_purged'
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

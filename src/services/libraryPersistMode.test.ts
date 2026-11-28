/**
 * @jest-environment node
 */
// what the persisted account record may hold is judged by the library's own state, not by the localStorage flag alone.
import { readFileSync } from 'fs'
import { join } from 'path'
import { keepStoredChats } from './chatsFloor'
import { libraryHoldsCopy, libraryHoldsForMode } from './senderCopy'
import { CHAT_BODIES_PURGED_KEY, libraryPersistModeFor, noteLibraryEvidence, profilesForPersist, resetLibraryEvidenceForTest, countChatMessages } from './chatLocalPurge'

const EOA = '0x1111111111111111111111111111111111111111'
const OTHER = '0x3333333333333333333333333333333333333333'
const PEER = '0x2222222222222222222222222222222222222222'

const profiles = (): unknown[] => [{ keyID: EOA, chats: [{ address: PEER, unreadCount: 0, messages: [{ id: 'm1', sendId: 's1', from: 'me', text: 'BODY-1', createdAt: 1, status: 'sent' }], preview: 'BODY-1' }] }]

class MemStorage {
	private m = new Map<string, string>()
	getItem(k: string) { return this.m.get(k) ?? null }
	setItem(k: string, v: string) { this.m.set(k, v) }
	removeItem(k: string) { this.m.delete(k) }
}

beforeEach(() => {
	;(globalThis as { localStorage?: unknown }).localStorage = new MemStorage()
	resetLibraryEvidenceForTest()
})

describe('profilesForPersist: the flag is lost, the library decides', () => {
	for (const state of ['purged', 'switched']) {
		it(`flag missing, library state ${state}: the persisted record holds no bodies (guarded mode)`, () => {
			noteLibraryEvidence({ eoa: EOA, capable: true, state })
			expect(libraryPersistModeFor(EOA)).toBe('guarded')
			expect(countChatMessages(profilesForPersist(profiles()))).toBe(0)
			expect(JSON.stringify(profilesForPersist(profiles()))).not.toContain('BODY-1')
		})
	}
	it('flag missing, the library exists but did not answer (unknown): no bodies are written either', () => {
		noteLibraryEvidence({ eoa: EOA, capable: true, state: null })
		expect(libraryPersistModeFor(EOA)).toBe('guarded')
		expect(JSON.stringify(profilesForPersist(profiles()))).not.toContain('BODY-1')
	})
	it('the flag set: no bodies, whatever the evidence says (positive evidence only)', () => {
		;(globalThis as { localStorage: MemStorage }).localStorage.setItem(CHAT_BODIES_PURGED_KEY, EOA)
		noteLibraryEvidence({ eoa: EOA, capable: true, state: 'none' })
		expect(libraryPersistModeFor(EOA)).toBe('library')
		expect(countChatMessages(profilesForPersist(profiles()))).toBe(0)
	})
	it('RECORD-BASED users and SHELLS keep their bodies: library state none / running / complete; no library on this client (a native shell: its migrationState throws); nothing read yet; evidence of another account', () => {
		for (const state of ['none', 'running', 'complete']) {
			noteLibraryEvidence({ eoa: EOA, capable: true, state })
			expect(libraryPersistModeFor(EOA)).toBe('record')
			expect(JSON.stringify(profilesForPersist(profiles()))).toContain('BODY-1')
		}
		noteLibraryEvidence({ eoa: EOA, capable: false, state: null }) // a shell: the read fails because there is no library, not because the worker is slow
		expect(libraryPersistModeFor(EOA)).toBe('record')
		expect(JSON.stringify(profilesForPersist(profiles()))).toContain('BODY-1')
		resetLibraryEvidenceForTest()
		expect(libraryPersistModeFor(EOA)).toBe('record')
		noteLibraryEvidence({ eoa: OTHER, capable: true, state: 'purged' })
		expect(libraryPersistModeFor(EOA)).toBe('record')
		expect(JSON.stringify(profilesForPersist(profiles()))).toContain('BODY-1')
	})
	it('the evidence is per account and case-insensitive; it is replaced by the next read (the state moves on)', () => {
		noteLibraryEvidence({ eoa: EOA.toUpperCase().replace('0X', '0x'), capable: true, state: 'purged' })
		expect(libraryPersistModeFor(EOA)).toBe('guarded')
		noteLibraryEvidence({ eoa: EOA, capable: true, state: 'none' })
		expect(libraryPersistModeFor(EOA)).toBe('record')
	})
	it('the original profiles are never mutated (memory keeps the bodies; only the persisted copy is stripped)', () => {
		noteLibraryEvidence({ eoa: EOA, capable: true, state: 'purged' })
		const original = profiles()
		profilesForPersist(original)
		expect(JSON.stringify(original)).toContain('BODY-1')
	})
})

describe('the chats floor follows the same mode: only a KNOWN library mode drops stored bodies', () => {
	const stored = { profiles: [{ keyID: EOA, chats: [{ address: PEER, unreadCount: 0, messages: [{ id: 'm1', sendId: 's1', from: 'me', text: 'BODY-1', createdAt: 1, status: 'sent' }] }] }] }
	const next = { profiles: [{ keyID: EOA, chats: [{ address: PEER, unreadCount: 0, messages: [] }] }] }
	const bodiesAfter = (mode: 'library' | 'guarded' | 'record') => JSON.stringify(keepStoredChats(next, stored, { keepMessages: mode !== 'library' }))
	it('library (the flag: a verified purge): stored bodies are not brought back; guarded (no flag) and record: what is already stored stays, it may be the only copy', () => {
		expect(bodiesAfter('library')).not.toContain('BODY-1')
		expect(bodiesAfter('guarded')).toContain('BODY-1')
		expect(bodiesAfter('record')).toContain('BODY-1')
	})
	it('beamio.ts derives keepMessages from the mode, and the persisted copies go through profilesForPersist', () => {
		const src = readFileSync(join(__dirname, 'beamio.ts'), 'utf8')
		expect(src).toMatch(/return \{ keepMessages: !isExactRecordWrite\(\) && libraryPersistModeFor\(eoa\) !== 'library' \}/)
		expect(src).not.toMatch(/keepMessages: !isChatBodiesPurgedFor/)
		expect((src.match(/profilesForPersist\(ensureFlatProfiles\(temp\.profiles\)\)/g) ?? []).length).toBe(2)
	})
	it('the pure rule: only the flag drops stored bodies; evidence without the flag (purged, switched, unknown) keeps them', () => {
		for (const state of ['purged', 'switched', null]) {
			noteLibraryEvidence({ eoa: EOA, capable: true, state })
			expect(libraryPersistModeFor(EOA) !== 'library').toBe(true)
		}
		;(globalThis as { localStorage: MemStorage }).localStorage.setItem(CHAT_BODIES_PURGED_KEY, EOA)
		expect(libraryPersistModeFor(EOA) !== 'library').toBe(false)
	})
	it('an end-to-end write after the flag was lost: the new body is not written, the stored one is not destroyed', () => {
		noteLibraryEvidence({ eoa: EOA, capable: true, state: 'purged' })
		const memory = profiles() // the page still holds BODY-1 in memory
		const persisted = { profiles: profilesForPersist(memory) }
		expect(JSON.stringify(persisted)).not.toContain('BODY-1') // nothing new goes into the record
		const storedBefore = { profiles: [{ keyID: EOA, chats: [{ address: PEER, unreadCount: 0, messages: [{ id: 'old', sendId: 's0', from: 'me', text: 'BODY-OLD', createdAt: 0, status: 'sent' }] }] }] }
		const floored = keepStoredChats(persisted, storedBefore, { keepMessages: libraryPersistModeFor(EOA) !== 'library' })
		expect(JSON.stringify(floored)).toContain('BODY-OLD') // a body that may be the only copy stays until the library confirms it
		expect(JSON.stringify(floored)).not.toContain('BODY-1')
	})
})

describe('the evidence is fed by the reads that already happen (wiring)', () => {
	const migration = readFileSync(join(__dirname, 'chatLocalMigration.ts'), 'utf8')
	const chat = readFileSync(join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
	const bridge = readFileSync(join(__dirname, 'chatWorkerBridge.ts'), 'utf8')
	it('the client has a library only when it is the browser worker (a native client is never library evidence)', () => {
		expect(bridge).toMatch(/export const localChatLibraryCapable = \(\): boolean => !!activeClient && !activeClientIsNative && typeof activeClient\.history\?\.migrationState === 'function'/)
	})
	it('the migration start and its outcome refresh the evidence through the bounded read; an unknown state is asked again', () => {
		expect(migration).toMatch(/const capable = localChatLibraryCapable\(\)\s*const state = capable \? await readLibraryStateBounded\(localChatMigrationState\) : null\s*noteLibraryEvidence\(\{ eoa, capable, state \}\)/)
		expect(migration).toMatch(/if \(capable && state === null\) ensureLibraryEvidenceRetry\(eoa\)/)
		expect(migration).toMatch(/const out = await runOnceInner\(\)/)
		expect(migration).toMatch(/const state = \(await refreshLibraryEvidence\(profileEoaOf\(profiles\)\)\) \?\? 'none'/)
	})
	it('every library decision of the chat page feeds it', () => {
		expect(chat).toMatch(/const capableNow = localChatLibraryCapable\(\)\s*noteLibraryEvidence\(\{ eoa, capable: capableNow, state: libState \}\)/)
	})
})

describe('an UNKNOWN read never overwrites a known state, and the sender\'s copy follows the same mode', () => {
	it('known complete / none -> one timeout -> still record (the record keeps its bodies, no guarded flicker)', () => {
		for (const known of ['complete', 'none', 'running']) {
			resetLibraryEvidenceForTest()
			noteLibraryEvidence({ eoa: EOA, capable: true, state: known })
			noteLibraryEvidence({ eoa: EOA, capable: true, state: null })
			expect(libraryPersistModeFor(EOA)).toBe('record')
			expect(JSON.stringify(profilesForPersist(profiles()))).toContain('BODY-1')
		}
	})
	it('known purged / switched -> a timeout -> still guarded (the last known state stays); a later real read replaces it', () => {
		for (const known of ['purged', 'switched']) {
			resetLibraryEvidenceForTest()
			noteLibraryEvidence({ eoa: EOA, capable: true, state: known })
			noteLibraryEvidence({ eoa: EOA, capable: true, state: null })
			expect(libraryPersistModeFor(EOA)).toBe('guarded')
		}
		noteLibraryEvidence({ eoa: EOA, capable: true, state: 'complete' })
		expect(libraryPersistModeFor(EOA)).toBe('record')
	})
	it('never read + unknown stays unknown (guarded); another account\'s known state does not stand in; a client without a library is not kept as known', () => {
		noteLibraryEvidence({ eoa: EOA, capable: true, state: null })
		expect(libraryPersistModeFor(EOA)).toBe('guarded')
		resetLibraryEvidenceForTest()
		noteLibraryEvidence({ eoa: OTHER, capable: true, state: 'complete' })
		noteLibraryEvidence({ eoa: EOA, capable: true, state: null })
		expect(libraryPersistModeFor(EOA)).toBe('guarded')
		resetLibraryEvidenceForTest()
		noteLibraryEvidence({ eoa: EOA, capable: true, state: 'purged' })
		noteLibraryEvidence({ eoa: EOA, capable: false, state: null }) // the client changed: no library
		expect(libraryPersistModeFor(EOA)).toBe('record')
	})
	it('the sender\'s copy follows the persisted record: shell and record-based accounts are not held for a library ACK; a known or unknown browser library is', () => {
		const holds = (eoa: string) => libraryHoldsForMode(libraryPersistModeFor(eoa))
		expect(holds(EOA)).toBe(false) // nothing read
		noteLibraryEvidence({ eoa: EOA, capable: false, state: null }) // native shell
		expect(holds(EOA)).toBe(false)
		noteLibraryEvidence({ eoa: EOA, capable: true, state: 'complete' })
		expect(holds(EOA)).toBe(false)
		noteLibraryEvidence({ eoa: EOA, capable: true, state: null }) // kept as known complete
		expect(holds(EOA)).toBe(false)
		resetLibraryEvidenceForTest()
		noteLibraryEvidence({ eoa: EOA, capable: true, state: null })
		expect(holds(EOA)).toBe(true)
		noteLibraryEvidence({ eoa: EOA, capable: true, state: 'purged' })
		expect(holds(EOA)).toBe(true)
		;(globalThis as { localStorage: MemStorage }).localStorage.setItem(CHAT_BODIES_PURGED_KEY, EOA)
		noteLibraryEvidence({ eoa: EOA, capable: false, state: null })
		expect(holds(EOA)).toBe(true) // the flag alone still counts
	})
	it('the pure libraryHoldsCopy agrees with the mode for a first read, for every (flag, state, capability)', () => {
		const states: Array<string | null> = ['none', 'running', 'complete', 'switched', 'purged', null]
		for (const flag of [false, true]) {
			for (const capable of [false, true]) {
				for (const state of states) {
					resetLibraryEvidenceForTest()
					;(globalThis as { localStorage: MemStorage }).localStorage = new MemStorage()
					if (flag) (globalThis as { localStorage: MemStorage }).localStorage.setItem(CHAT_BODIES_PURGED_KEY, EOA)
					noteLibraryEvidence({ eoa: EOA, capable, state })
					expect(`${flag}/${capable}/${state}:${libraryHoldsForMode(libraryPersistModeFor(EOA))}`).toBe(`${flag}/${capable}/${state}:${libraryHoldsCopy(flag, state, capable)}`)
				}
			}
		}
	})
	it('the chat page asks an unknown read again (10 s retry), the same as the migration start', () => {
		const chat = readFileSync(join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
		expect(chat).toMatch(/if \(capableNow && libState === null\) ensureLibraryEvidenceRetry\(eoa\)/)
		const migration = readFileSync(join(__dirname, 'chatLocalMigration.ts'), 'utf8')
		expect(migration).toMatch(/export function ensureLibraryEvidenceRetry\(eoa: string\): void \{\s*if \(!eoa \|\| evidenceRetry !== null \|\| evidenceRetries >= 30\) return/)
		expect(migration).toMatch(/if \(capable && state === null\) ensureLibraryEvidenceRetry\(eoa\)/)
	})
	it('the migration outcome refreshes the evidence before runOnce returns', () => {
		const migration = readFileSync(join(__dirname, 'chatLocalMigration.ts'), 'utf8')
		expect(migration).toMatch(/const out = await runOnceInner\(\)[\s\S]*?await refreshLibraryEvidence\(profileEoaOf\(profiles\)\)\.catch\(\(\) => null\)\s*return out/)
	})
	it('an exact write (the cleanup of confirmed bodies) writes the record as it is and does not let the floor bring stored messages back; it ends with the call, also when it throws', async () => {
		const { withExactRecordWrite, isExactRecordWrite } = await import('./chatLocalPurge')
		noteLibraryEvidence({ eoa: EOA, capable: true, state: 'purged' }) // guarded: normally no bodies
		expect(JSON.stringify(profilesForPersist(profiles()))).not.toContain('BODY-1')
		await withExactRecordWrite(async () => {
			expect(isExactRecordWrite()).toBe(true)
			expect(JSON.stringify(profilesForPersist(profiles()))).toContain('BODY-1')
		})
		expect(isExactRecordWrite()).toBe(false)
		await expect(withExactRecordWrite(async () => { throw new Error('x') })).rejects.toThrow()
		expect(isExactRecordWrite()).toBe(false)
		expect(JSON.stringify(profilesForPersist(profiles()))).not.toContain('BODY-1')
	})
	it('the start path cleans the bodies the library confirms and restores the flag only when none is left; the cleanup persist is an exact write', () => {
		const migration = readFileSync(join(__dirname, 'chatLocalMigration.ts'), 'utf8')
		expect(migration).toMatch(/if \(bodiesLeft > 0 && localChatLibraryCapable\(\)\) \{\s*await cleanRecordBodies\(productionCleanupDeps\(\)\)\.catch\(\(\) => null\)\s*bodiesLeft = countChatMessages\(/)
		expect(migration).toMatch(/if \(eoaPurged && bodiesLeft === 0\) markChatBodiesPurged\(eoaPurged\)/)
		expect(migration).toMatch(/persistProfiles: \(\) => withExactRecordWrite\(\(\) => storeSystemDataAndWait\(\)\)/)
		expect(migration).toMatch(/readDecryptedChatHistory\(\{ peer, caller: 'recordBodyCleanup' \}\)/)
		expect(migration).toMatch(/if \(!entries\) return null/)
	})
})


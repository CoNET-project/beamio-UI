/**
 * @jest-environment node
 */
// refreshLibraryEvidence (chatLocalMigration.ts): the library's state, read with the 5 s bound, becomes the evidence of the persistence rule; a client without a library is not "unknown".
const bridge = { capable: true, state: 'purged' as string | null | 'hang' | 'throw' }
jest.mock('./beamio', () => ({ readStoredProfilesForVerify: jest.fn(), storeSystemDataAndWait: jest.fn() }))
jest.mock('@/utils/globals', () => ({ CoNET_Data: { profiles: [{ keyID: '0x1111111111111111111111111111111111111111', chats: [] }] } }), { virtual: true })
jest.mock('./chatWorkerBridge', () => ({
	localChatLibraryCapable: () => bridge.capable,
	localChatMigrationState: () => {
		if (bridge.state === 'hang') return new Promise(() => undefined)
		if (bridge.state === 'throw') return Promise.reject(new Error('local chat library unavailable on this client'))
		return Promise.resolve(bridge.state as string | null)
	},
	lockLocalChat: jest.fn(),
	migrateLocalChatHistory: jest.fn(),
	purgeLocalChatPlain: jest.fn(),
	switchLocalChatHistory: jest.fn(),
}))

import { refreshEvidenceOnWorkerReady, refreshLibraryEvidence } from './chatLocalMigration'
import { readFileSync } from 'fs'
import { join } from 'path'
import { libraryPersistModeFor, resetLibraryEvidenceForTest } from './chatLocalPurge'

const EOA = '0x1111111111111111111111111111111111111111'
beforeEach(() => {
	jest.useFakeTimers()
	resetLibraryEvidenceForTest()
	;(globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
	bridge.capable = true
	bridge.state = 'purged'
})
afterEach(() => jest.useRealTimers())

describe('refreshLibraryEvidence', () => {
	it('the library says purged (switched): library mode for the persistence rule, flag or not', async () => {
		for (const state of ['purged', 'switched']) {
			resetLibraryEvidenceForTest()
			bridge.state = state
			expect(await refreshLibraryEvidence(EOA)).toBe(state)
			expect(libraryPersistModeFor(EOA)).toBe('guarded')
		}
	})
	it('record-based states stay record mode', async () => {
		for (const state of ['none', 'running', 'complete']) {
			bridge.state = state
			await refreshLibraryEvidence(EOA)
			expect(libraryPersistModeFor(EOA)).toBe('record')
		}
	})
	it('a NATIVE SHELL has no library: its read fails, and that is NOT unknown: bodies stay (the rule that keeps shells and record-based users from losing chat bodies)', async () => {
		bridge.capable = false
		bridge.state = 'throw'
		expect(await refreshLibraryEvidence(EOA)).toBeNull()
		expect(libraryPersistModeFor(EOA)).toBe('record')
	})
	it('the browser library that does not answer within 5 s is unknown (no bodies written, stored bodies kept) and is asked again every 10 s until it answers', async () => {
		bridge.state = 'hang'
		const p = refreshLibraryEvidence(EOA)
		jest.advanceTimersByTime(5001)
		expect(await p).toBeNull()
		expect(libraryPersistModeFor(EOA)).toBe('guarded')
		bridge.state = 'none' // the worker answers now: the library is record-based, the cautious mode ends by itself
		jest.advanceTimersByTime(10_001)
		for (let i = 0; i < 6; i++) await Promise.resolve()
		expect(libraryPersistModeFor(EOA)).toBe('record')
	})
	it('a refusal (the worker throws) is unknown for a capable client', async () => {
		bridge.state = 'throw'
		expect(await refreshLibraryEvidence(EOA)).toBeNull()
		expect(libraryPersistModeFor(EOA)).toBe('guarded')
	})
	it('no account: nothing is recorded', async () => {
		expect(await refreshLibraryEvidence('')).toBeNull()
		expect(libraryPersistModeFor(EOA)).toBe('record')
	})
})

describe(' the product rule: the worker-ready event reads the library evidence at once', () => {
	it('an account whose flag was lost starts as `record` (no evidence) and moves to `guarded` as soon as the worker is ready and the library answers purged / switched; a record-based library stays record', async () => {
		for (const state of ['purged', 'switched']) {
			resetLibraryEvidenceForTest()
			bridge.state = state
			expect(libraryPersistModeFor(EOA)).toBe('record') // the startup default, before any read
			expect(await refreshEvidenceOnWorkerReady()).toBe(state)
			expect(libraryPersistModeFor(EOA)).toBe('guarded')
		}
		resetLibraryEvidenceForTest()
		bridge.state = 'complete'
		await refreshEvidenceOnWorkerReady()
		expect(libraryPersistModeFor(EOA)).toBe('record')
	})
	it('a library that does not answer yet is unknown and is asked again every 10 s (the same retry as the migration start); a refusal or no account never throws', async () => {
		bridge.state = 'hang'
		const p = refreshEvidenceOnWorkerReady()
		jest.advanceTimersByTime(5001)
		expect(await p).toBeNull()
		expect(libraryPersistModeFor(EOA)).toBe('guarded')
		bridge.state = 'purged'
		jest.advanceTimersByTime(10_001)
		for (let i = 0; i < 6; i++) await Promise.resolve()
		expect(libraryPersistModeFor(EOA)).toBe('guarded')
		bridge.state = 'throw'
		await expect(refreshEvidenceOnWorkerReady()).resolves.toBeNull()
	})
	it('App.tsx runs it from the same worker-ready subscription that bumps the epoch, independent of the wallet unlock the migration needs', () => {
		const app = readFileSync(join(__dirname, '../App.tsx'), 'utf8')
		expect(app).toMatch(/onWorkerReady\(\(\) => \{ setWorkerEpoch\(\(n\) => n \+ 1\); if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true'\) qaEvent\('chat_worker_ready'\); void refreshEvidenceOnWorkerReady\(\) \}\)/)
		const mig = readFileSync(join(__dirname, 'chatLocalMigration.ts'), 'utf8')
		expect(mig).toMatch(/export function refreshEvidenceOnWorkerReady\(\): Promise<string \| null> \{[\s\S]*?return refreshLibraryEvidence\(eoa\)\.catch\(\(\) => null\)/)
	})
})

describe('the lost-flag start window (a write that runs before the evidence read answers)', () => {
	const chats = () => [{ keyID: EOA, chats: [{ address: '0x2222222222222222222222222222222222222222', messages: [{ sendId: 's1', text: 'SYNTHETIC-BODY', from: 'me' }], preview: 'SYNTHETIC-BODY' }] }]
	const bodiesOf = (profiles: unknown): number => ((profiles as Array<{ chats: Array<{ messages: unknown[] }> }>)[0].chats[0].messages ?? []).length
	it('the mode is `guarded` SYNCHRONOUSLY when the worker is ready, before the library answers: a debounced write in that window persists NO bodies', async () => {
		const { profilesForPersist } = await import('./chatLocalPurge')
		bridge.state = 'hang' // the library has not answered yet
		expect(libraryPersistModeFor(EOA)).toBe('record') // before the worker is ready: the startup default, unchanged
		const p = refreshEvidenceOnWorkerReady()
		// no await: this is the instant between the worker-ready event and the first answer of the library
		expect(libraryPersistModeFor(EOA)).toBe('guarded')
		expect(bodiesOf(profilesForPersist(chats()))).toBe(0) // the write that "wins the race" strips the bodies
		jest.advanceTimersByTime(5001)
		expect(await p).toBeNull()
		expect(libraryPersistModeFor(EOA)).toBe('guarded')
	})
	it('the answer then decides: a record-based library ends the cautious mode, a library state keeps it; the default is not changed for a client without a library', async () => {
		const { profilesForPersist } = await import('./chatLocalPurge')
		bridge.state = 'complete'
		const p = refreshEvidenceOnWorkerReady()
		expect(libraryPersistModeFor(EOA)).toBe('guarded')
		expect(await p).toBe('complete')
		expect(libraryPersistModeFor(EOA)).toBe('record')
		expect(bodiesOf(profilesForPersist(chats()))).toBe(1)
		resetLibraryEvidenceForTest()
		bridge.capable = false // a native shell: no library client, nothing is put under guard
		bridge.state = 'throw'
		const q = refreshEvidenceOnWorkerReady()
		expect(libraryPersistModeFor(EOA)).toBe('record')
		await q
		expect(libraryPersistModeFor(EOA)).toBe('record')
	})
	it('an account whose state is already KNOWN (record-based) is not put under guard by the worker-ready event', async () => {
		bridge.state = 'complete'
		await refreshLibraryEvidence(EOA)
		expect(libraryPersistModeFor(EOA)).toBe('record')
		bridge.state = 'hang'
		const p = refreshEvidenceOnWorkerReady()
		expect(libraryPersistModeFor(EOA)).toBe('record') // the unknown pre-note does not overwrite the known state
		jest.advanceTimersByTime(5001)
		await p
		expect(libraryPersistModeFor(EOA)).toBe('record')
	})
	it('the pre-note is the first statement of refreshEvidenceOnWorkerReady, before the async read, and only for a capable client', () => {
		const src = readFileSync(join(__dirname, 'chatLocalMigration.ts'), 'utf8')
		const fn = src.slice(src.indexOf('export function refreshEvidenceOnWorkerReady'), src.indexOf('async function runOnce()'))
		expect(fn).toMatch(/if \(eoa && localChatLibraryCapable\(\)\) noteLibraryEvidence\(\{ eoa, capable: true, state: null \}\)\s*\n\s*return refreshLibraryEvidence\(eoa\)\.catch\(\(\) => null\)/)
	})
})

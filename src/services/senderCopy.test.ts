// where the sender's copy lives and when the queue may let go of the item (senderCopy.ts).
import { LIBRARY_STATE_TIMEOUT_MS, libraryHoldsCopy, libraryHoldsForClient, libraryHoldsForMode, readLibraryStateBounded, senderCopyDurable } from './senderCopy'

describe('libraryHoldsCopy', () => {
	it('true when the chat bodies were purged, when the library is switched on or purged, and when the state cannot be told; false only for a known record-based state', () => {
		expect(libraryHoldsCopy(true, 'none')).toBe(true)
		expect(libraryHoldsCopy(false, 'switched')).toBe(true)
		expect(libraryHoldsCopy(false, 'purged')).toBe(true)
		expect(libraryHoldsCopy(false, null)).toBe(true) // the worker is not ready: the library ACK is what counts
		for (const s of ['none', 'running', 'complete']) expect(libraryHoldsCopy(false, s)).toBe(false)
	})
})

describe('senderCopyDurable', () => {
	it('outside library mode the record write decides; in library mode only the library ACK does (a succeeded record write says nothing: the bodies are stripped)', async () => {
		const never = async () => { throw new Error('must not ask') }
		expect(await senderCopyDurable({ recordPersisted: true, libraryHolds: false, alreadyAcked: false, ackLibrary: never })).toBe(true)
		expect(await senderCopyDurable({ recordPersisted: false, libraryHolds: false, alreadyAcked: false, ackLibrary: never })).toBe(false)
		let asked = 0
		expect(await senderCopyDurable({ recordPersisted: true, libraryHolds: true, alreadyAcked: false, ackLibrary: async () => { asked += 1; return false } })).toBe(false)
		expect(await senderCopyDurable({ recordPersisted: false, libraryHolds: true, alreadyAcked: false, ackLibrary: async () => { asked += 1; return true } })).toBe(true)
		expect(asked).toBe(2)
	})
	it('an ACK that was already received is not asked for again; a library call that throws is "not durable", never an error', async () => {
		expect(await senderCopyDurable({ recordPersisted: false, libraryHolds: true, alreadyAcked: true, ackLibrary: async () => { throw new Error('no') } })).toBe(true)
		expect(await senderCopyDurable({ recordPersisted: true, libraryHolds: true, alreadyAcked: false, ackLibrary: async () => { throw new Error('worker gone') } })).toBe(false)
	})
})

describe('the library state read is bounded (a worker that hangs must not keep the queue item busy)', () => {
	beforeEach(() => jest.useFakeTimers())
	afterEach(() => jest.useRealTimers())
	it('an answer in time is the answer', async () => {
		const p = readLibraryStateBounded(async () => 'switched')
		await expect(p).resolves.toBe('switched')
		await expect(readLibraryStateBounded(async () => 'none')).resolves.toBe('none')
	})
	it('no answer within the bound: unknown (null), which counts as library mode', async () => {
		const p = readLibraryStateBounded(() => new Promise<string | null>(() => undefined), 5000)
		jest.advanceTimersByTime(4999)
		let settled = false
		void p.then(() => { settled = true })
		await Promise.resolve()
		expect(settled).toBe(false)
		jest.advanceTimersByTime(2)
		await expect(p).resolves.toBeNull()
		expect(libraryHoldsCopy(false, null)).toBe(true)
	})
	it('a refusal or a synchronous throw is unknown too', async () => {
		await expect(readLibraryStateBounded(() => Promise.reject(new Error('x')))).resolves.toBeNull()
		await expect(readLibraryStateBounded(() => { throw new Error('y') })).resolves.toBeNull()
	})
	it('the default bound is 5 s and chat.tsx reads the state only through it', () => {
		expect(LIBRARY_STATE_TIMEOUT_MS).toBe(5000)
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const chat = require('fs').readFileSync(require('path').join(__dirname, '../pages/chat/chat.tsx'), 'utf8') as string
		expect(chat).toMatch(/const libState = await readLibraryStateBounded\(localChatMigrationState\)/)
	})
})

describe('the purged flag is lost at a SIGKILL; the library\'s own state decides', () => {
	it('flag missing, the library says switched or purged: library mode; flag missing and the library state cannot be read: library mode (the safe side)', () => {
		for (const state of ['switched', 'purged', null]) expect(libraryHoldsCopy(false, state)).toBe(true)
	})
	it('flag missing and the library is record-based (none, running, complete): not library mode; the flag present is library mode whatever the state says', () => {
		for (const state of ['none', 'running', 'complete']) {
			expect(libraryHoldsCopy(false, state)).toBe(false)
			expect(libraryHoldsCopy(true, state)).toBe(true)
		}
	})
	it('with the flag lost and the library present, the queue item waits for the library ACK: the record write alone releases nothing; the ACK does', async () => {
		let asked = 0
		const holds = libraryHoldsCopy(false, 'purged')
		const withoutAck = await senderCopyDurable({ recordPersisted: true, libraryHolds: holds, alreadyAcked: false, ackLibrary: async () => { asked += 1; return false } })
		expect(withoutAck).toBe(false)
		expect(asked).toBe(1)
		const withAck = await senderCopyDurable({ recordPersisted: true, libraryHolds: holds, alreadyAcked: false, ackLibrary: async () => true })
		expect(withAck).toBe(true)
	})
	it('chat.tsx decides from the flag AND the library state it just read, and exports both for QA', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const chat = require('fs').readFileSync(require('path').join(__dirname, '../pages/chat/chat.tsx'), 'utf8') as string
		expect(chat).toMatch(/const flag = isChatBodiesPurgedFor\(eoa\)\s*const libState = await readLibraryStateBounded\(localChatMigrationState\)/)
		expect(chat).toMatch(/const holds = libraryHoldsForClient\(\{ mode: libraryPersistModeFor\(eoa\), capable: capableNow, nativeShell: isShellContext\(\) \}\)/)
		expect(chat).toMatch(/purgedFlag: libraryEvidenceRef\.current\?\.flag \?\? null, libraryState: libraryEvidenceRef\.current\?\.state \?\? null/)
	})
})

describe('a shell without a library is never library mode', () => {
	const modes: Array<'library' | 'guarded' | 'record'> = ['library', 'guarded', 'record']
	it('a native shell with no library capability holds nothing in a library: record based, whatever mode a stray flag or evidence gives', () => {
		for (const mode of modes) expect(libraryHoldsForClient({ mode, capable: false, nativeShell: true })).toBe(false)
	})
	it('every other client keeps the three-way mode: a browser whose worker is not up yet (capable false, not a shell) and a capable client', () => {
		for (const mode of modes) {
			expect(libraryHoldsForClient({ mode, capable: false, nativeShell: false })).toBe(libraryHoldsForMode(mode))
			expect(libraryHoldsForClient({ mode, capable: true, nativeShell: false })).toBe(libraryHoldsForMode(mode))
			expect(libraryHoldsForClient({ mode, capable: true, nativeShell: true })).toBe(libraryHoldsForMode(mode))
		}
	})
	it('the sender copy and the delivered document both ask: libraryHoldsNow goes through libraryHoldsForClient with localChatLibraryCapable(), and markDeliveredDurable returns before any write in a shell', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const chat = require('fs').readFileSync(require('path').join(__dirname, '../pages/chat/chat.tsx'), 'utf8') as string
		expect(chat).toMatch(/const capableNow = localChatLibraryCapable\(\)/)
		expect(chat).toMatch(/libraryHoldsForClient\(\{ mode: libraryPersistModeFor\(eoa\), capable: capableNow, nativeShell: isShellContext\(\) \}\)/)
		expect(chat).not.toMatch(/libraryHoldsForMode\(libraryPersistModeFor/)
		const at = chat.indexOf('const markDeliveredDurable = async')
		const body = chat.slice(at, chat.indexOf('const senderCopyPersisted', at))
		expect(body.indexOf('!localChatLibraryCapable() && isShellContext()')).toBeGreaterThan(0)
		expect(body.indexOf('!localChatLibraryCapable() && isShellContext()')).toBeLessThan(body.indexOf('store.put('))
		expect(body.indexOf('!localChatLibraryCapable() && isShellContext()')).toBeLessThan(body.indexOf('libraryHoldsNow()'))
	})
})

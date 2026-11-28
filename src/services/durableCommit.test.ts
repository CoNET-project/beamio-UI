/**
 * @jest-environment node
 */
// the chat gets an explicit outcome of THIS durable commit; three cases are failures: the write gate is closed, there is no record at the
// check, and there is no record inside the serial turn. SYNTHETIC; every dependency is injected.
import { commitDurable, flushContract, durableCommitError, type DurableCommitDeps } from './durableCommit'
import { runPersistSerial } from './persistSerial'

function deps(over: Partial<DurableCommitDeps> = {}) {
	const heard: boolean[] = []
	const written: string[] = []
	let timerCancelled = 0
	const d: DurableCommitDeps = {
		cancelPendingTimer: () => { timerCancelled += 1 },
		takeWaiters: () => [(ok: boolean) => heard.push(ok)],
		gateOpen: () => true,
		hasRecord: () => true,
		runSerial: runPersistSerial,
		writeSnapshot: async () => { written.push('record'); return true },
		...over,
	}
	return { d, heard, written, timerCancelled: () => timerCancelled }
}

describe('commitDurable: the four outcomes', () => {
	it('committed: the record landed; the waiters hear true', async () => {
		const { d, heard, written } = deps()
		expect(await commitDurable(d)).toEqual({ result: 'committed' })
		expect(written).toEqual(['record'])
		expect(heard).toEqual([true])
	})
	it('1) the write gate is closed: gate_closed, nothing written, the waiters hear false', async () => {
		const { d, heard, written } = deps({ gateOpen: () => false })
		expect((await commitDurable(d)).result).toBe('gate_closed')
		expect(written).toEqual([])
		expect(heard).toEqual([false])
	})
	it('2) no record at the check: no_record, nothing written, the waiters hear false', async () => {
		const { d, heard, written } = deps({ hasRecord: () => false })
		expect((await commitDurable(d)).result).toBe('no_record')
		expect(written).toEqual([])
		expect(heard).toEqual([false])
	})
	it('3) the record is gone inside the serial turn: no_record (NOT committed), the waiters hear false', async () => {
		const { d, heard } = deps({ writeSnapshot: async () => false })
		expect((await commitDurable(d)).result).toBe('no_record')
		expect(heard).toEqual([false])
	})
	it('the write throws: write_failed with the error; the waiters hear false', async () => {
		const boom = new Error('idb write rejected')
		const { d, heard } = deps({ writeSnapshot: async () => { throw boom } })
		expect(await commitDurable(d)).toEqual({ result: 'write_failed', error: boom })
		expect(heard).toEqual([false])
	})
	it('the pending debounced write is cancelled in every case (this write takes its place)', async () => {
		for (const over of [{}, { gateOpen: () => false }, { hasRecord: () => false }, { writeSnapshot: async () => false }, { writeSnapshot: async () => { throw new Error('x') } }]) {
			const { d, timerCancelled } = deps(over as Partial<DurableCommitDeps>)
			await commitDurable(d)
			expect(timerCancelled()).toBe(1)
		}
	})
})

describe('the other callers keep the flushStoreSystemData contract', () => {
	it('committed -> true; gate_closed and no_record -> false; write_failed -> throws the original error', () => {
		expect(flushContract({ result: 'committed' })).toBe(true)
		expect(flushContract({ result: 'gate_closed' })).toBe(false)
		expect(flushContract({ result: 'no_record' })).toBe(false)
		const boom = new Error('x')
		expect(() => flushContract({ result: 'write_failed', error: boom })).toThrow(boom)
	})
	it('the chat error names the case; committed has none', () => {
		expect(durableCommitError('committed')).toBeNull()
		expect(durableCommitError('gate_closed')?.message).toBe('persist_gate_closed')
		expect(durableCommitError('no_record')?.message).toBe('persist_no_record')
		expect(durableCommitError('write_failed')?.message).toBe('persist_write_failed')
	})
})

describe('the wiring (static)', () => {
	const fs = require('fs')
	const path = require('path')
	const beamio = fs.readFileSync(path.join(__dirname, 'beamio.ts'), 'utf8')
	it('beamio.ts builds both entries on commitDurable, and the debounced timer does not report an empty turn as stored', () => {
		expect(beamio).toMatch(/export const commitForChat = async \(\) => \(await commitDurableReal\(\)\)\.result/)
		expect(beamio).toMatch(/export const flushStoreSystemData = async \(\): Promise<boolean> => flushContract\(await commitDurableReal\(\)\)/)
		expect(beamio).toMatch(/stored = await runPersistSerial\(async \(\) => \{\s*if \(!CoNET_Data\) return false/)
	})
	it('the chat checks the commit result (a write that did not land is an error), it does not just await it', () => {
		const chat = fs.readFileSync(path.join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
		expect(chat).toMatch(/const failure = durableCommitError\(await commitForChat\(\)\)\s*if \(failure\) throw failure/)
		expect(chat).not.toMatch(/if \(immediate\) await flushStoreSystemData\(\)/)
	})
})

/**
 * @jest-environment node
 */
// every write of the page record runs one after the other, and takes its snapshot when its turn begins; the immediate writes of a message the user just sent or received
// are not put off by the debounce.
import fs from 'fs'
import path from 'path'
import { runPersistSerial } from './persistSerial'

describe('runPersistSerial', () => {
	it('tasks never overlap and run in the order they were asked; the last one to land holds the newest data', async () => {
		const store = { value: 'v0' }
		const memory = { value: 'v0' }
		const events: string[] = []
		const write = (label: string, delayMs: number) =>
			runPersistSerial(async () => {
				const snapshot = memory.value // taken when the turn begins
				events.push(`start:${label}:${snapshot}`)
				await new Promise((r) => setTimeout(r, delayMs))
				store.value = snapshot
				events.push(`end:${label}`)
			})
		memory.value = 'sent'
		const a = write('A', 30) // slow, asked first
		memory.value = 'sent+received'
		const b = write('B', 1) // fast, asked second
		await Promise.all([a, b])
		expect(events).toEqual(['start:A:sent+received', 'end:A', 'start:B:sent+received', 'end:B'])
		expect(store.value).toBe('sent+received')
	})
	it('a failed write does not stop the ones after it', async () => {
		await expect(runPersistSerial(async () => { throw new Error('x') })).rejects.toThrow('x')
		await expect(runPersistSerial(async () => 'ok')).resolves.toBe('ok')
	})
})

describe('the wiring (static)', () => {
	const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8')
	it('both writers of the page record (the debounced timer and the immediate commit, durableCommit) run through the serial runner', () => {
		const beamio = read('beamio.ts')
		expect(beamio).toMatch(/stored = await runPersistSerial\(async \(\) => \{/)
		expect(beamio).toMatch(/runSerial: runPersistSerial,/)
	})
	it('storeSystemDataNow flushes at once and the inbound commits use it (the mailbox is told only after the message landed)', () => {
		const beamio = read('beamio.ts')
		expect(beamio).toMatch(/export const storeSystemDataNow = \(\): Promise<boolean> =>[\s\S]*?storeSystemDataWaiters\.push\(resolve\)\s*void flushStoreSystemData\(\)/)
		const app = read('../App.tsx')
		expect(app.match(/commit: storeSystemDataNow,/g)).toHaveLength(2)
		expect(app).not.toMatch(/commit: storeSystemDataAndWait,/)
	})
})

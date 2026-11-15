/**
 * @jest-environment node
 *
 * The native account check sits on the main shell read path and before the gate enters the native wallet. A static check
 * of the source, since the read path needs the native bridge.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', 'src', rel.replace(/^src\//, '')), 'utf8')

describe('page record read path', () => {
	it('the shell storage read checks the record against the native account before it returns the record', () => {
		const beamio = read('services/beamio.ts')
		const start = beamio.indexOf('const readStorageWithStatus = async')
		const end = beamio.indexOf('/** A read for a user action', start)
		const region = beamio.slice(start, end)
		const check = region.indexOf('shellRecordReadState(rec, native)')
		const giveRecord = region.indexOf("if (!rec) return { status: 'empty' }")
		expect(check).toBeGreaterThan(-1)
		expect(region.indexOf('readWalletEoaAddress()')).toBeGreaterThan(-1)
		expect(check).toBeLessThan(giveRecord + 1000)
		expect(region.indexOf('state.kind === \'unavailable\'')).toBeGreaterThan(-1)
	})

	it('the gate prepares the entry (record check and key hold) before every entry into the native wallet', () => {
		const gate = read('components/AppEntryGate.tsx')
		expect(gate).toContain('const prepareShellEntry = async')
		const entries: number[] = []
		let at = gate.indexOf('applyNativeWallet(native.eoa)')
		while (at !== -1) {
			entries.push(at)
			at = gate.indexOf('applyNativeWallet(native.eoa)', at + 1)
		}
		expect(entries.length).toBeGreaterThanOrEqual(2)
		for (const e of entries) {
			expect(gate.slice(Math.max(0, e - 400), e)).toContain('prepareShellEntry(native.eoa)')
		}
		expect(gate).toContain("pre.reason === 'eoa_mismatch'")
		expect(gate).not.toContain('recordAllowsEntry')
	})
})

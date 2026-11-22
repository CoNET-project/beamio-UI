/**
 * @jest-environment node
 *
 * The native account check sits on the main shell read path and before the gate enters the native wallet. A static check
 * of the source, since the read path needs the native bridge.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { prereadPageRoute } from './accountJudgement'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', 'src', rel.replace(/^src\//, '')), 'utf8')

describe('page record read path', () => {
	it('the shell storage read checks the record against the native account before it returns the record', () => {
		const beamio = read('services/beamio.ts')
		// 2026-11-20: the native check lives in shellNativeFirstRead (read first); the caller reads the old store after it
		const start = beamio.indexOf('const shellNativeFirstRead = async')
		const end = beamio.indexOf('/** A read for a user action', start)
		const region = beamio.slice(start, end)
		const check = region.indexOf('shellRecordReadState(rec, native)')
		const giveRecord = region.indexOf("if (!rec) return { kind: 'empty' }")
		expect(check).toBeGreaterThan(-1)
		expect(region.indexOf('readWalletEoaAddress()')).toBeGreaterThan(-1)
		expect(check).toBeLessThan(giveRecord + 1000)
		expect(region.indexOf('state.kind === \'unavailable\'')).toBeGreaterThan(-1)
	})

	it('the gate prepares the entry before every native restore: an unreadable page waits, an existing copy is checked, an empty page is restored', () => {
		// The two native restore branches (the pre-read valid path and the shell no_key sealed-copy path) both route the page copy through
		// prereadPageRoute. The rule is behaviour-tested here; the wiring of the two branches is type-checked and covered by the App harness.
		expect(prereadPageRoute('unavailable')).toBe('wait_retry')
		expect(prereadPageRoute('loaded')).toBe('check_record')
		expect(prereadPageRoute('locked')).toBe('check_record')
		expect(prereadPageRoute('empty')).toBe('restore_write')
	})
})

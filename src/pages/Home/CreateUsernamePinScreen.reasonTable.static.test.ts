/**
 * @jest-environment node
 *
 * The write_failed reason table (v10 §九 OB-1…OB-4, lines 283–286 verbatim; rule). Each row: the normal submit enabled or
 * disabled (writeHold), and the dedicated button. Test IDs RT-1…RT-5 are my own naming.
 *   internal_state     (OB-2, line 284): "同上；重试先 reread"  -> normal submit enabled (the retry); the open path rereads first.
 *   storage_write      (OB-1, line 283): "显示重试"             -> normal submit enabled (the retry); no dedicated button.
 * rollback_pending (OB-3, line 285): "按钮条件同第六节" -> dedicated OB-3 button; normal submit HELD; the OB-3 button bypasses the hold.
 *   old_copy_unverified(OB-4, line 286): "无按钮；说明"          -> normal submit disabled; explanation only.
 * missing / outside -> normal submit disabled; explanation only; reread before any action.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, 'CreateUsernamePinScreen.tsx'), 'utf8')

describe('write_failed reason table (v10 OB-1…OB-4)', () => {
	it('RT-1 internal_state and storage_write are not held (the normal submit is the retry)', () => {
		const hold = src.slice(src.indexOf('setWriteHold('), src.indexOf('setWriteHold(') + 260)
		expect(hold).not.toMatch(/'internal_state'/)
		expect(hold).not.toMatch(/'storage_write'/)
	})

	it('RT-2 rollback_pending holds the normal submit; the OB-3 dedicated button bypasses writeHold and is the only rollback retry', () => {
		const hold = src.slice(src.indexOf('setWriteHold('), src.indexOf('setWriteHold(') + 500)
		expect(hold).toMatch(/'rollback_pending'/)
		expect(src).toContain('onClick={() => void onSubmitPress(true)}')
		expect(src).toContain('if (!canSubmit || (writeHold && !bypassWriteHold)) return')
		expect(src).toContain('onClick={() => void onSubmitPress()}')
	})

	it('RT-3 old_copy_unverified is held (v10 OB-4 无按钮) and shows the explanation', () => {
		expect(src).toContain("accepted.reason === 'old_copy_unverified'))")
		expect(src).toContain("setCreateError(tu('shell_sync_old_copy_unverified_body'))")
	})

	it('RT-4 missing or out-of-vocabulary reason is held (the most conservative case) and rereads before any action', () => {
		expect(src).toContain("accepted.reason === undefined")
		expect(src).toContain('if (createRereadRequiredRef.current) {')
	})

	it('RT-5 the held state lasts for the page session (set, not cleared by the normal submit path)', () => {
		const clears = (src.match(/setWriteHold\(false\)/g) || []).length
		expect(clears).toBe(0)
	})
})

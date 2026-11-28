/**
 * locked release points (plan §一, LK-P1…LK-P10): a locked wallet never releases the gate, the entry decision, the
 * create-screen readiness, or the retry. Only unlocked does. Static: the source is read, nothing is run. Synthetic only.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { judgeShell, judgeShellFromNative } from './accountJudgement'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8')

describe('LK-P1…LK-P10: no release point accepts locked (only unlocked)', () => {
	const gate = read('src/components/AppEntryGate.tsx')
	const decision = read('src/services/shellEntryDecision.ts')
	const create = read('src/pages/Home/CreateUsernamePinScreen.tsx')

	// The gate's own `native.status === 'unlocked'` release branches were removed on purpose; the release rule now lives in the
	// pure judgement: a locked state never enters, and only an unlocked walletStatus (old-shell route) or a valid record enters.
	it('LK-P1, LK-P2, LK-P3, LK-P4, LK-P5: the judgement releases on unlocked only, a locked state is the unlock action', () => {
		expect(gate).not.toMatch(/native\.status === 'locked' \|\| native\.status === 'unlocked'/)
		expect(judgeShell('absent', 'locked')).toEqual({ account: 'undetermined', action: 'unlock' })
		// rule 2026-11-20: a valid PWA mnemonic enters /home whatever the native lock is (judgeShell's first rule)
		expect(judgeShell('valid_mnemonic', 'locked')).toEqual({ account: 'has_account', action: 'enter' })
		expect(judgeShellFromNative({ idb: 'absent', walletState: 'not_reported', walletStatus: 'locked' })).toEqual({ account: 'undetermined', action: 'unlock' })
		expect(judgeShellFromNative({ idb: 'absent', walletState: 'not_reported', walletStatus: 'unlocked' })).toEqual({ account: 'has_account', action: 'enter' })
	})
	it('LK-P8: the entry decision enters native on unlocked only', () => {
		expect(decision).not.toMatch(/'locked' \|\| .*'unlocked'/)
		expect(decision).toMatch(/native\.status === 'unlocked'\) return 'enter_native'/)
	})
	it('LK-P9, LK-P10: the create screen notifies readiness on unlocked only', () => {
		expect(create).not.toMatch(/st\.status === 'locked' \|\| st\.status === 'unlocked'/)
		expect(create.match(/st\.status === 'unlocked'/g)?.length ?? 0).toBeGreaterThanOrEqual(1)
	})
});

/**
 * S25: the not-ready page showed Try again and Retry together. While any gate start screen is shown (not only the retry screen), the
 * identity prompt (its own Try again) is not mounted. The hold page shows only the gate's retry, the unlock control when
 * locked, and one restore button (existing restore route, no onboarding entry). Static pin of these conditions; removing them must fail.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, 'AppEntryGate.tsx'), 'utf8')

describe('one retry control on the start screens', () => {
	it('the identity prompt is mounted only when no gate start screen is shown', () => {
		expect(src).toContain('{!storageUnavailable && !(splashVisible && startupRetryOffered) && <IdentityEntryPrompt />}')
		expect(src).not.toContain('<IdentityEntryPrompt />\n')
	})
	it('the hold page does not open the identity prompt (no dispatch of its event from the gate)', () => {
		expect(src).not.toContain('IDENTITY_ENTRY_PROMPT_EVENT')
	})
	it('the hold page restore button enters the existing restore route only (no onboarding or create entry)', () => {
		expect(src).toContain("onClick={openRestoreFromHold}")
		expect(src).toContain("{tu('restore_wallet')}")
		expect(src).toContain('openRestoreFromHold={restoreFromHold}')
	})
})

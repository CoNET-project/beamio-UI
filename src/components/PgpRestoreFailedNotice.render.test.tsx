/**
 * (revises): class 4 (not_ready) shows its body only, with no replace button, until the native replacement exists.
 * The not_supported defence stays: the notice shows "not supported in this version" and hides the button, with no retry. SYNTHETIC.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import PgpRestoreFailedNotice, { generateAnswerOutcome, showsReplaceButton } from './PgpRestoreFailedNotice'
import { isShellContext } from '../services/shellContext'
import { nativeGenerateNewPgpKey } from '../services/nativePgpRestore'
import { regeneratePgpKeyByUser } from '../services/chat'
import { grantPgpCreateEligibility, revokePgpCreateEligibility } from '../services/pgpIdentityEligibility'

jest.mock('../locale/beamioLocale', () => ({ tu: (key: string) => key }))
jest.mock('../services/shellContext', () => ({ isShellContext: jest.fn() }))
jest.mock('../services/nativeIdentityPublic', () => ({ shellAccountKeyOrEmpty: () => 'synthetic-account-key' }))
jest.mock('../services/nativePgpRestore', () => ({ nativeGenerateNewPgpKey: jest.fn() }))
jest.mock('../services/chat', () => ({ regeneratePgpKeyByUser: jest.fn() }))

const isShell = isShellContext as jest.MockedFunction<typeof isShellContext>
const nativeGen = nativeGenerateNewPgpKey as jest.MockedFunction<typeof nativeGenerateNewPgpKey>
const browserGen = regeneratePgpKeyByUser as jest.MockedFunction<typeof regeneratePgpKeyByUser>

beforeEach(() => {
	isShell.mockReset()
	nativeGen.mockReset()
	browserGen.mockReset()
})

describe('class 4 (not_ready) shows its body only', () => {
	it('the not_ready notice has no replace button, in a shell or a browser', () => {
		isShell.mockReturnValue(true)
		render(<PgpRestoreFailedNotice code="pgp_restore_not_ready" />)
		expect(screen.getByText('chat.restore_not_ready.body')).toBeTruthy()
		expect(screen.queryByRole('button')).toBeNull()
		expect(nativeGen).not.toHaveBeenCalled()
	})
	it('the not_ready notice in a browser has no button either, and never generates', () => {
		isShell.mockReturnValue(false)
		render(<PgpRestoreFailedNotice code="pgp_restore_not_ready" />)
		expect(screen.queryByRole('button')).toBeNull()
		expect(browserGen).not.toHaveBeenCalled()
	})
	it('the pure rule: class 4 has no button; the other failure classes keep theirs', () => {
		expect(showsReplaceButton('pgp_restore_not_ready')).toBe(false)
		for (const c of ['pgp_backup_missing', 'pgp_backup_undecryptable', 'pgp_fingerprint_mismatch', 'pgp_registration_missing'] as const) {
			expect(showsReplaceButton(c)).toBe(true)
		}
	})
})

describe('pgp_verify_failed (native challenge-signature gate): "restore failed" with the user-click entry, nothing automatic', () => {
	it('shows chat.restore_failed.body and the generate entry (chat.restore_generate.entry) when eligible; the click is the only generate', async () => {
		isShell.mockReturnValue(true)
		grantPgpCreateEligibility('synthetic-account-key')
		render(<PgpRestoreFailedNotice code="pgp_verify_failed" />)
		expect(screen.getByText('chat.restore_failed.body')).toBeTruthy()
		expect(screen.queryByText('chat.restore_not_ready.body')).toBeNull()
		const btn = screen.getByRole('button')
		expect(btn.textContent).toBe('chat.restore_generate.entry')
		expect(nativeGen).not.toHaveBeenCalled()
		nativeGen.mockResolvedValue({ ok: false, reason: 'native_unavailable' })
		fireEvent.click(btn)
		await waitFor(() => expect(nativeGen).toHaveBeenCalledTimes(1))
	})
	it('the pure rule: the entry rule is the same as for the other failure classes', () => {
		expect(showsReplaceButton('pgp_verify_failed')).toBe(true)
	})
})

describe('the not_supported defence stays, for the other classes that have a button', () => {
	it('shell: a not_supported answer shows the placeholder copy, hides the button, and does not retry', async () => {
		isShell.mockReturnValue(true)
		grantPgpCreateEligibility('synthetic-account-key')
		nativeGen.mockResolvedValue({ ok: false, reason: 'not_supported' })
		render(<PgpRestoreFailedNotice code="pgp_backup_missing" />)
		fireEvent.click(screen.getByRole('button'))
		expect(await screen.findByText('chat.replace_not_supported')).toBeTruthy()
		expect(screen.queryByRole('button')).toBeNull()
		expect(nativeGen).toHaveBeenCalledTimes(1)
	})
	it('shell: any other refusal keeps the retry line and the button', async () => {
		isShell.mockReturnValue(true)
		grantPgpCreateEligibility('synthetic-account-key')
		nativeGen.mockResolvedValue({ ok: false, reason: 'pending_exists' })
		render(<PgpRestoreFailedNotice code="pgp_backup_missing" />)
		fireEvent.click(screen.getByRole('button'))
		expect(await screen.findByText('chat.restore_retry.body')).toBeTruthy()
		expect(screen.queryByText('chat.replace_not_supported')).toBeNull()
		expect(screen.getByRole('button')).toBeTruthy()
	})
})

describe('the answer outcome (pure)', () => {
	it('success reloads; not_supported is unsupported; any other refusal is a retry', () => {
		expect(generateAnswerOutcome({ ok: true })).toBe('reload')
		expect(generateAnswerOutcome({ ok: false, reason: 'not_supported' })).toBe('unsupported')
		expect(generateAnswerOutcome({ ok: false, reason: 'pending_exists' })).toBe('retry')
		expect(generateAnswerOutcome({ ok: false })).toBe('retry')
	})

	it('first-identity rule: shell without the first-identity eligibility renders no create button (the switch is not the gate)', () => {
		isShell.mockReturnValue(true)
		revokePgpCreateEligibility('synthetic-account-key')
		render(<PgpRestoreFailedNotice code="pgp_backup_missing" />)
		expect(screen.queryByRole('button')).toBeNull()
	})
})

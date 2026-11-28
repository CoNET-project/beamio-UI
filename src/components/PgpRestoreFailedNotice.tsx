/**
 * The Chat route after a PGP restore failure (plan A). The copy is a draft pending the review; the
 * English copy waits for the interface review. The page never generates a key by itself: the button is the only way, and it
 * is the user's click. The rule is the same in a browser and in a shell: a browser generates and registers in the page
 * (the approved exception), a shell calls the native layer. Wallet and asset pages are not affected.
 *
 * Class 4 (`pgp_restore_not_ready`, the explicit replacement):. Neither native layer implements the replacement yet,
 * so the not_ready notice shows its body only, with no button. The not_supported defence stays: an answer of not_supported shows
 * "not supported in this version"and hides the button for this session, with no retry.
 *
 * TEST BENCH (transitional): the shell's generate command is provisional until the interface maintainers confirm it.
 */
import { requestUserReload } from '@/services/chatWriteLock'
import { useState } from 'react'
import { tu } from '../locale/beamioLocale'
import { isShellContext } from '../services/shellContext'
import { nativeGenerateNewPgpKey } from '../services/nativePgpRestore'
import { shellAccountKeyOrEmpty } from '../services/nativeIdentityPublic'
import { regeneratePgpKeyByUser } from '../services/chat'
import type { PgpRestoreFailure } from '../services/pgpRestore'
import { pgpCreateEligible } from '../services/pgpIdentityEligibility'
import { PGP_IDENTITY_CREATE_ENABLED } from '../utils/pgpIdentityCreateFlag'
import { pgpCreateFailureCopyKey } from '../services/pgpCreateFailureCopy'

/** The replacement button is not shown for class 4 until the native replacement exists. */
export function showsReplaceButton(code: PgpRestoreFailure): boolean {
	return code !== 'pgp_restore_not_ready'
}

/** What a generate answer does on the page: success reloads; not_supported shows the notice and hides the button; others show the retry line. */
export function generateAnswerOutcome(result: { ok: boolean; reason?: string }): 'reload' | 'unsupported' | 'retry' {
	if (result.ok) return 'reload'
	if (result.reason === 'not_supported') return 'unsupported'
	return 'retry'
}

export default function PgpRestoreFailedNotice({ code: _code }: { code: PgpRestoreFailure }) {
	const [busy, setBusy] = useState(false)
	const [failedKey, setFailedKey] = useState<string | null>(null)
	const [unsupported, setUnsupported] = useState(false)

	const generate = async () => {
		// not_ready (class 4) is a shell action only; a browser never generates from it.
		if (_code === 'pgp_restore_not_ready' && !isShellContext()) {
			setFailedKey('chat.restore_retry.body')
			return
		}
		setBusy(true)
		setFailedKey(null)
		const result = isShellContext() ? await nativeGenerateNewPgpKey(shellAccountKeyOrEmpty()) : await regeneratePgpKeyByUser()
		setBusy(false)
		const outcome = generateAnswerOutcome(result)
		if (outcome === 'reload') {
			requestUserReload() // held while a chat write is in progress or a message exists only in memory
			return
		}
		if (outcome === 'unsupported') {
			// not supported in this version; no retry, and the replace button is hidden for this session.
			setUnsupported(true)
			return
		}
		setFailedKey(pgpCreateFailureCopyKey(!result.ok && 'reason' in result ? result.reason : undefined))
	}

	// first-identity rule: in a shell the create action is shown only for a confirmed first identity (same rule in every build)
	// 0.53.52: with the click path closed in a shell (PGP_IDENTITY_CREATE_ENABLED false) the button is not shown either: no click that sends nothing
	const shellNotEligible = isShellContext() && (!PGP_IDENTITY_CREATE_ENABLED || !pgpCreateEligible(shellAccountKeyOrEmpty()))
	const hideButton = unsupported || !showsReplaceButton(_code) || shellNotEligible

	return (
		<div role="status" className="flex min-h-0 flex-1 flex-col items-center justify-center bg-[#071126] px-6 text-center text-white">
			<div className="w-full max-w-md rounded-3xl border border-white/15 bg-white/10 p-6 shadow-2xl backdrop-blur-xl">
				<h1 className="text-xl font-semibold">{tu(_code === 'pgp_restore_not_ready' ? 'chat.restore_not_ready.body' : 'chat.restore_failed.body')}</h1>
				{unsupported ? (
					<p role="alert" className="mt-3 text-sm leading-6 text-amber-200">
						{tu('chat.replace_not_supported')}
					</p>
				) : null}
				{failedKey !== null && (
					<p role="alert" className="mt-3 text-sm leading-6 text-amber-200">
						{tu(failedKey)}
					</p>
				)}
				{hideButton ? null : (
					<div className="mt-5 flex justify-center">
						<button
							type="button"
							disabled={busy}
							onClick={() => void generate()}
							className="rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-[#071126] disabled:opacity-60"
						>
							{tu(_code === 'pgp_restore_not_ready' ? 'chat.restore_failed.entry' : 'chat.restore_generate.entry')}
						</button>
					</div>
				)}
			</div>
		</div>
	)
}

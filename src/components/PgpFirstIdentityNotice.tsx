/**
 * The first chat identity of a wallet: no chain record and no backup. The copy is the
 * `chat.first_identity.*` set. Nothing is generated without the user's click; the click sends `pgpIdentityCreate`, and the
 * native layer confirms it. 0.53.52: the click path is closed (PGP_IDENTITY_CREATE_ENABLED = false) and the gate never shows this notice (the SDK sets the first identity
 * up itself); if it is ever shown with the path closed, there is no button, so a click that sends nothing cannot happen. The failure line names its reason.
 */
import { requestUserReload } from '@/services/chatWriteLock'
import { useState } from 'react'
import { tu } from '../locale/beamioLocale'
import { nativeGenerateNewPgpKey } from '../services/nativePgpRestore'
import { shellAccountKeyOrEmpty } from '../services/nativeIdentityPublic'
import { pgpCreateEligible } from '../services/pgpIdentityEligibility'
import { PGP_IDENTITY_CREATE_ENABLED } from '../utils/pgpIdentityCreateFlag'
import { pgpCreateFailureCopyKey } from '../services/pgpCreateFailureCopy'
import { isShellContext } from '../services/shellContext'

export default function PgpFirstIdentityNotice() {
	const [busy, setBusy] = useState(false)
	const [failureKey, setFailureKey] = useState<string | null>(null)

	const create = async () => {
		setBusy(true)
		setFailureKey(null)
		const result = await nativeGenerateNewPgpKey(shellAccountKeyOrEmpty())
		setBusy(false)
		if (result.ok) {
			requestUserReload() // held while a chat write is in progress or a message exists only in memory
			return
		}
		setFailureKey(pgpCreateFailureCopyKey(result.reason))
	}

	return (
		<div role="status" className="flex min-h-0 flex-1 flex-col items-center justify-center bg-[#071126] px-6 text-center text-white">
			<div className="w-full max-w-md rounded-3xl border border-white/15 bg-white/10 p-6 shadow-2xl backdrop-blur-xl">
				<h1 className="text-xl font-semibold">{tu('chat.first_identity.body')}</h1>
				{failureKey !== null && (
					<p role="alert" className="mt-3 text-sm leading-6 text-amber-200">
						{tu(failureKey)}
					</p>
				)}
				{(!isShellContext() || (PGP_IDENTITY_CREATE_ENABLED && pgpCreateEligible(shellAccountKeyOrEmpty()))) && (
				<div className="mt-5 flex justify-center">
					<button
						type="button"
						disabled={busy}
						onClick={() => void create()}
						className="rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-[#071126] disabled:opacity-60"
					>
						{tu('chat.first_identity.entry')}
					</button>
				</div>
				)}
			</div>
		</div>
	)
}

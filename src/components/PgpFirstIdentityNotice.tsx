/**
 * The first chat identity of a wallet: no chain record and no backup. The copy is the
 * `chat.first_identity.*` set. Nothing is generated without the user's click; the click sends `pgpIdentityCreate`, and the
 * native layer confirms it. While the chain write path is off (PGP_IDENTITY_CREATE_ENABLED = false, every build but QA), the page sends nothing
 * and shows the retry copy `chat.restore_retry.body`, not a failure line.
 */
import { useState } from 'react'
import { tu } from '../locale/beamioLocale'
import { nativeGenerateNewPgpKey } from '../services/nativePgpRestore'
import { shellAccountKeyOrEmpty } from '../services/nativeIdentityPublic'

export default function PgpFirstIdentityNotice() {
	const [busy, setBusy] = useState(false)
	const [retry, setRetry] = useState(false)

	const create = async () => {
		setBusy(true)
		setRetry(false)
		const result = await nativeGenerateNewPgpKey(shellAccountKeyOrEmpty())
		setBusy(false)
		if (result.ok) {
			window.location.reload()
			return
		}
		setRetry(true)
	}

	return (
		<div role="status" className="flex min-h-0 flex-1 flex-col items-center justify-center bg-[#071126] px-6 text-center text-white">
			<div className="w-full max-w-md rounded-3xl border border-white/15 bg-white/10 p-6 shadow-2xl backdrop-blur-xl">
				<h1 className="text-xl font-semibold">{tu('chat.first_identity.body')}</h1>
				{retry && (
					<p role="alert" className="mt-3 text-sm leading-6 text-amber-200">
						{tu('chat.restore_retry.body')}
					</p>
				)}
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
			</div>
		</div>
	)
}

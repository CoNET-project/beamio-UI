/**
 * Locked page for a native shell that has no wallet key for this account. No chat or wallet content mounts.
 * The page never takes a key: the import button only asks the shell to open its native import screen.
 */
import { useEffect, useState } from 'react'
import { Lock } from 'lucide-react'
import { tu } from '../locale/beamioLocale'
import { openNativeKeyImport, readNativeWalletStatus } from '../services/nativeKeyState'

export default function NativeKeyImportRequired() {
	const [busy, setBusy] = useState(false)
	const [failed, setFailed] = useState(false)
	/** The import screen is open: its close is only seen by reading the wallet state again. */
	const [awaitingReturn, setAwaitingReturn] = useState(false)

	const importWallet = async () => {
		setBusy(true)
		setFailed(false)
		const result = await openNativeKeyImport()
		setBusy(false)
		if (result === 'opened') {
			setAwaitingReturn(true)
			return
		}
		setFailed(true)
	}

	// When the page is visible again, read walletStatus. Only a ready state (G1 or G2) reloads the app, so the gate re-runs its boot.
	useEffect(() => {
		if (!awaitingReturn) return
		const recheck = async () => {
			if (document.visibilityState !== 'visible') return
			const status = await readNativeWalletStatus()
			if (status === 'not_ready' || status === 'locked' || status === 'unlocked') window.location.reload()
		}
		document.addEventListener('visibilitychange', recheck)
		window.addEventListener('focus', recheck)
		return () => {
			document.removeEventListener('visibilitychange', recheck)
			window.removeEventListener('focus', recheck)
		}
	}, [awaitingReturn])

	return (
		<div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-[#071126] px-6 text-center text-white">
			<div className="w-full max-w-md rounded-3xl border border-white/15 bg-white/10 p-6 shadow-2xl backdrop-blur-xl">
				<div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-white/15">
					<Lock className="h-6 w-6" aria-hidden="true" />
				</div>
				<h1 className="text-xl font-semibold">{tu('native_key_required_title')}</h1>
				<p className="mt-3 text-sm leading-6 text-white/75">{tu('native_key_required_body')}</p>
				{failed && (
					<p role="alert" className="mt-3 text-sm leading-6 text-amber-200">
						{tu('native_key_import_failed')}
					</p>
				)}
				<div className="mt-5 flex flex-col items-center gap-3">
					<button
						type="button"
						disabled={busy}
						onClick={() => void importWallet()}
						className="rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-[#071126] disabled:opacity-60"
					>
						{tu('native_key_required_import')}
					</button>
					<button
						type="button"
						onClick={() => window.location.reload()}
						className="text-sm text-white/75 underline"
					>
						{tu('native_key_required_retry')}
					</button>
				</div>
			</div>
		</div>
	)
}

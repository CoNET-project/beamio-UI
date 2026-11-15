/**
 * the chat notices of a shell whose identity module is closed, and of a start whose automatic retries stopped.
 *
 * - Closed (`init` answered clear_failed or unregister_refused): no automatic retry. The button starts the clear: a confirmation, then
 *   `clearIdentity`. The native layer runs its recovery-source check and refuses without deleting anything when it fails. After a
 *   successful clear the page reloads, which re-judges the account. When the closed state came from an account import, the button
 *   goes back to the native import page instead (the native layer confirms there).
 * - Retries stopped (the sixth consecutive failed start): "chat is unavailable" with a manual retry.
 *
 * The copy is a placeholder pending final wording. SYNTHETIC values only.
 */
import { useEffect, useState } from 'react'
import { tu } from '../locale/beamioLocale'
import { nativeRecoveryOpen } from '../services/nativeRecovery'
import {
	clearShellChatIdentity,
	getIdentityClosed,
	setIdentityClosed,
	subscribeIdentityClosed,
	type IdentityClosedState,
} from '../services/shellIdentityClosed'
import { getShellRetryExhausted, requestShellRetryNow, subscribeShellRetryExhausted } from '../services/shellChatRetryCap'

export function useIdentityClosedState(): IdentityClosedState {
	const [state, setState] = useState<IdentityClosedState>(() => getIdentityClosed())
	useEffect(() => subscribeIdentityClosed(setState), [])
	return state
}

export function useShellRetryExhausted(): boolean {
	const [value, setValue] = useState<boolean>(() => getShellRetryExhausted())
	useEffect(() => subscribeShellRetryExhausted(setValue), [])
	return value
}

const reloadPage = () => window.location.reload()

type View = 'idle' | 'confirm' | 'busy'

/** The closed notice. `onCleared` runs after a successful clear (the default reloads the page, which re-judges the account). */
export function ShellIdentityClosedNotice({ onCleared }: { onCleared?: () => void } = {}) {
	const closed = useIdentityClosedState()
	const [view, setView] = useState<View>('idle')
	const [refused, setRefused] = useState(false)
	if (!closed) return null
	const fromImport = closed.source === 'import'

	const clear = async () => {
		setView('busy')
		setRefused(false)
		let outcome: Awaited<ReturnType<typeof clearShellChatIdentity>>
		try {
			outcome = await clearShellChatIdentity()
		} catch {
			outcome = { kind: 'failed', code: 'exception' }
		}
		if (outcome.kind === 'ok') {
			setIdentityClosed(null)
			;(onCleared ?? reloadPage)()
			return
		}
		// A refusal removes nothing and keeps the notice. Any other answer also keeps the notice as it is.
		setView('idle')
		if (outcome.kind === 'refused') setRefused(true)
	}

	return (
		<div role="status" className="flex min-h-0 flex-1 flex-col items-center justify-center bg-[#071126] px-6 text-center text-white">
			<div className="w-full max-w-md rounded-3xl border border-white/15 bg-white/10 p-6 shadow-2xl backdrop-blur-xl">
				<h1 className="text-xl font-semibold">{tu('chat.clear_failed.body')}</h1>
				{view === 'confirm' && <p className="mt-3 text-sm leading-6 text-white/75">{tu('chat.clear_confirm.body')}</p>}
				{refused && view !== 'confirm' && (
					<p role="alert" className="mt-3 text-sm leading-6 text-amber-200">
						{tu('chat.clear_refused.body')}
					</p>
				)}
				<div className="mt-5 flex flex-wrap justify-center gap-3">
					{view === 'confirm' ? (
						<>
							<button
								type="button"
								onClick={() => void clear()}
								className="rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-[#071126]"
							>
								{tu('chat.clear_confirm.ok')}
							</button>
							<button
								type="button"
								onClick={() => setView('idle')}
								className="rounded-full border border-white/30 px-5 py-2.5 text-sm font-semibold text-white"
							>
								{tu('cancel')}
							</button>
						</>
					) : fromImport ? (
						<button
							type="button"
							disabled={view === 'busy'}
							onClick={() => void nativeRecoveryOpen()}
							className="rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-[#071126] disabled:opacity-60"
						>
							{tu('chat.import_retry.entry')}
						</button>
					) : (
						<button
							type="button"
							disabled={view === 'busy'}
							onClick={() => setView('confirm')}
							className="rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-[#071126] disabled:opacity-60"
						>
							{tu('chat.clear_failed.entry')}
						</button>
					)}
				</div>
			</div>
		</div>
	)
}

/** The start stopped its automatic retries. The button is the manual retry. */
export function ShellRetryExhaustedNotice() {
	return (
		<div role="status" className="flex min-h-0 flex-1 flex-col items-center justify-center bg-[#071126] px-6 text-center text-white">
			<div className="w-full max-w-md rounded-3xl border border-white/15 bg-white/10 p-6 shadow-2xl backdrop-blur-xl">
				<h1 className="text-xl font-semibold">{tu('shell_chat_unavailable_title')}</h1>
				<p className="mt-3 text-sm leading-6 text-white/75">{tu('chat.retry_exhausted.body')}</p>
				<div className="mt-5 flex justify-center">
					<button
						type="button"
						onClick={() => requestShellRetryNow()}
						className="rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-[#071126]"
					>
						{tu('retry')}
					</button>
				</div>
			</div>
		</div>
	)
}

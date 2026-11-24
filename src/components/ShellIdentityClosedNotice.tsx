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
import { useVisibleReadPoll } from '../hooks/useHelloWait'
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

/** The account settings hold the recovery-code backup. The default switches to them without a reload (the router listens to popstate). */
const openSettingsForBackup = () => {
	window.history.pushState({}, '', '/settings')
	window.dispatchEvent(new PopStateEvent('popstate', { state: {} }))
}

type View = 'idle' | 'confirm' | 'busy'
/**
 * The local account state of a refused reset (the decision): key_only = a private key and no recovery phrase on this device; has_mnemonic =
 * a valid phrase here (backup not confirmed); unknown = the state cannot be read. Read from the page record only (no native call, no write).
 */
type LocalKeyState = 'unknown' | 'key_only' | 'has_mnemonic'
async function readLocalKeyState(): Promise<LocalKeyState> {
	try {
		// loaded on demand: the page store module is heavy and is not needed for the other states of this notice
		const { readPageIdbInit, readPageIdbKeyState } = await import('../services/beamio')
		const st = await readPageIdbInit()
		if (st.status === 'valid') return 'has_mnemonic'
		// key_only needs both: no phrase here, and a private key in the record (); anything else is unknown
		if (st.status === 'unknown' && st.reason === 'no_mnemonic_record' && (await readPageIdbKeyState()) === 'key_only') return 'key_only'
		return 'unknown'
	} catch {
		return 'unknown'
	}
}
/** The last clear answer that the notice shows. `none` shows nothing extra. Neither answer counts as cleared or as "no account". */
type ClearNotice = 'none' | 'refused' | 'incomplete'

/**
 * The closed notice. `onCleared` runs after a successful clear (the default reloads the page, which re-judges the account).
 * `onOpenBackup` opens the recovery-code backup when a reset is refused.
 */
export function ShellIdentityClosedNotice({
	onCleared,
	onOpenBackup,
}: { onCleared?: () => void; onOpenBackup?: () => void } = {}) {
	const closed = useIdentityClosedState()
	const [view, setView] = useState<View>('idle')
	const [notice, setNotice] = useState<ClearNotice>('none')
	const [localKey, setLocalKey] = useState<LocalKeyState>('unknown')
	useEffect(() => {
		if (notice !== 'refused') return
		let alive = true
		void readLocalKeyState().then((v) => {
			if (alive) setLocalKey(v)
		})
		return () => {
			alive = false
		}
	}, [notice])
	if (!closed) return null
	const fromImport = closed.source === 'import'

	const clear = async () => {
		setView('busy')
		setNotice('none')
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
		// A refusal removes nothing, and an incomplete clear can be retried. Both keep the notice; neither is a clear.
		setView('idle')
		if (outcome.kind === 'refused') setNotice('refused')
		else if (outcome.kind === 'incomplete') setNotice('incomplete')
	}

	return (
		<div role="status" className="flex min-h-0 flex-1 flex-col items-center justify-center bg-[#071126] px-6 text-center text-white">
			<div className="w-full max-w-md rounded-3xl border border-white/15 bg-white/10 p-6 shadow-2xl backdrop-blur-xl">
				<h1 className="text-xl font-semibold">{tu('chat.clear_failed.body')}</h1>
				{view === 'confirm' && <p className="mt-3 text-sm leading-6 text-white/75">{tu('chat.clear_confirm.body')}</p>}
				{notice === 'incomplete' && view !== 'confirm' && (
					<p role="alert" className="mt-3 text-sm leading-6 text-amber-200">
						{tu('chat.clear_incomplete.body')}
					</p>
				)}
				{notice === 'refused' && view !== 'confirm' && (
					<p role="alert" className="mt-3 text-sm leading-6 text-amber-200">
						{localKey === 'key_only' ? tu('chat.refused_key_only.body') : localKey === 'has_mnemonic' ? tu('chat.clear_refused.body') : tu('chat.refused_unknown.body')}
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
					{notice === 'refused' && view !== 'confirm' && localKey === 'has_mnemonic' && (
						<button
							type="button"
							disabled={view === 'busy'}
							onClick={() => (onOpenBackup ?? openSettingsForBackup)()}
							className="rounded-full border border-white/30 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
						>
							{tu('chat.clear_refused.backup_entry')}
						</button>
					)}
				</div>
			</div>
		</div>
	)
}

/** The start stopped its automatic retries. The button is the manual retry. */
export function ShellRetryExhaustedNotice() {
	// the automatic retries are used up (the window, not a count): a read-only ask every 30 s while this is visible and the app is in the foreground
	useVisibleReadPoll(true, undefined, requestShellRetryNow)
	return (
		<div role="status" className="flex min-h-0 flex-1 flex-col items-center justify-center bg-[#071126] px-6 text-center text-white">
			<div className="w-full max-w-md rounded-3xl border border-white/15 bg-white/10 p-6 shadow-2xl backdrop-blur-xl">
				<h1 className="text-xl font-semibold">{tu('chat.try_later.title')}</h1>
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

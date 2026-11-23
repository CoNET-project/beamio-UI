/**
 * The unified "chat unavailable" state of a shell without the capability (option A). The copy is a draft, to be
 * confirmed by the review. It is not a lock page (that is for `no_key` only) and it holds no key.
 *
 * TEST BENCH (transitional): this is the stage before the native commands exist. It is not the final shell form;
 * the identity entries are re-pointed to the native commands one by one (plan in-shell-no-page-keys, step 2).
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { tu } from '../locale/beamioLocale'
import { getShellChatUiState, subscribeShellChatUiState } from '../services/shellChatUiState'
import type { UiState } from '../services/shellChatState'
import { getPgpRestoreFailure, subscribePgpRestoreFailure, type PgpRestoreFailure } from '../services/pgpRestore'
import PgpRestoreFailedNotice from './PgpRestoreFailedNotice'
import { getShellFirstIdentity, getShellIdentityPending, subscribeShellFirstIdentity, subscribeShellIdentityPending } from '../services/shellIdentitySource'
import PgpFirstIdentityNotice from './PgpFirstIdentityNotice'
import { ShellIdentityClosedNotice, ShellRetryExhaustedNotice, useIdentityClosedState, useShellRetryExhausted } from './ShellIdentityClosedNotice'
import { getShellPgpTemporary, getShellPgpTemporaryStopped, subscribeShellPgpTemporary } from '../services/shellPgpTemporary'
import { requestShellRetryNow } from '../services/shellChatRetryCap'
import { getNativeIdentityCapability, requestNativeIdentityRetry, subscribeNativeIdentityCapability } from '../services/nativeIdentityProbeRetry'

function usePgpTemporary(): boolean {
	return useSyncExternalStore(subscribeShellPgpTemporary, getShellPgpTemporary, getShellPgpTemporary)
}

/**
 * -6 / (1.1): the PGP source is temporarily unavailable. The chat retries on its own on the 30 s, 2 min, 10 min ladder;
 * when that is spent the notice stays and offers a manual retry. The copy is locale keys.
 */
export function ShellPgpTemporaryNotice() {
	const stopped = useSyncExternalStore(subscribeShellPgpTemporary, getShellPgpTemporaryStopped, getShellPgpTemporaryStopped)
	return (
		<div role="status" className="flex min-h-0 flex-1 flex-col items-center justify-center bg-[#071126] px-6 text-center text-white">
			<div className="w-full max-w-md rounded-3xl border border-white/15 bg-white/10 p-6 shadow-2xl backdrop-blur-xl">
				<p className="mt-3 text-sm leading-6 text-white/75">{tu(stopped ? 'pgp.temporary.stopped' : 'pgp.temporary.body')}</p>
				{stopped && (
					<button type="button" onClick={() => requestShellRetryNow()} className="mt-5 rounded-xl bg-[#2f80ed] px-4 py-2 text-sm font-medium text-white">
						{tu('pgp.temporary.retry')}
					</button>
				)}
			</div>
		</div>
	)
}

/**
 * `onBack`is given where the notice replaces a full-screen page (Android): the user must be able to leave it.
 */
export default function ShellChatUnavailableNotice({ onBack }: { onBack?: () => void } = {}) {
	// While the native hello is unanswered the hint says the native side is not ready yet, with a manual retry.
	const identity = useSyncExternalStore(subscribeNativeIdentityCapability, getNativeIdentityCapability, getNativeIdentityCapability)
	const unanswered = identity === 'unanswered'
	return (
		<div role="status" className="flex min-h-0 flex-1 flex-col items-center justify-center bg-[#071126] px-6 text-center text-white">
			<div className="w-full max-w-md rounded-3xl border border-white/15 bg-white/10 p-6 shadow-2xl backdrop-blur-xl">
				<h1 className="text-xl font-semibold">{tu('shell_chat_unavailable_title')}</h1>
				<p className="mt-3 text-sm leading-6 text-white/75">{tu(unanswered ? 'native_not_ready_hint' : 'shell_chat_unavailable_body')}</p>
				{unanswered ? (
					<button
						type="button"
						onClick={() => requestNativeIdentityRetry()}
						className="mt-5 rounded-xl bg-[#2f80ed] px-4 py-2 text-sm font-medium text-white"
					>
						{tu('native_not_ready_retry_action')}
					</button>
				) : null}
				{onBack ? (
					<button
						type="button"
						onClick={onBack}
						className="mt-5 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-[#071126]"
					>
						{tu('back')}
					</button>
				) : null}
			</div>
		</div>
	)
}

export function useShellChatUiState(): UiState {
	const [state, setState] = useState<UiState>(() => getShellChatUiState())
	useEffect(() => subscribeShellChatUiState(setState), [])
	return state
}

export function usePgpRestoreFailure(): PgpRestoreFailure | null {
	const [code, setCode] = useState<PgpRestoreFailure | null>(() => getPgpRestoreFailure())
	useEffect(() => subscribePgpRestoreFailure(setCode), [])
	return code
}

export function useShellFirstIdentity(): boolean {
	const [first, setFirst] = useState<boolean>(() => getShellFirstIdentity())
	useEffect(() => subscribeShellFirstIdentity(setFirst), [])
	return first
}

export function useShellIdentityPending(): boolean {
	const [pending, setPending] = useState<boolean>(() => getShellIdentityPending())
	useEffect(() => subscribeShellIdentityPending(setPending), [])
	return pending
}

/**no identity source after a restart. The page shows "retry later" and guesses nothing. */
/** The chat identity is pending (first-identity rule): the copy says so; it is not an app-update notice. */
export function ShellIdentityPendingNotice() {
	return (
		<div role="status" className="flex min-h-0 flex-1 flex-col items-center justify-center bg-[#071126] px-6 text-center text-white">
			<div className="w-full max-w-md rounded-3xl border border-white/15 bg-white/10 p-6 shadow-2xl backdrop-blur-xl">
				<h1 className="text-xl font-semibold">{tu('chat.identity_pending.title')}</h1>
				<p className="mt-2 text-sm leading-6 text-white/85">{tu('chat.identity_pending.body')}</p>
			</div>
		</div>
	)
}

export function ShellIdentityRetryNotice() {
	return (
		<div role="status" className="flex min-h-0 flex-1 flex-col items-center justify-center bg-[#071126] px-6 text-center text-white">
			<div className="w-full max-w-md rounded-3xl border border-white/15 bg-white/10 p-6 shadow-2xl backdrop-blur-xl">
				<h1 className="text-xl font-semibold">{tu('chat.restore_retry.body')}</h1>
			</div>
		</div>
	)
}

/**
 * Renders the chat in place of the notice unless the shell says otherwise. Order: a closed identity module, then
 * stopped automatic retries, then the unavailable state, then the identity and restore notices.
 */
export function ShellChatGate({ children }: { children: ReactNode }) {
	const state = useShellChatUiState()
	const pgp = usePgpRestoreFailure()
	const identityPending = useShellIdentityPending()
	const pgpTemporary = usePgpTemporary()
	const firstIdentity = useShellFirstIdentity()
	const closed = useIdentityClosedState()
	const retriesStopped = useShellRetryExhausted()
	if (closed) return <ShellIdentityClosedNotice />
	if (retriesStopped) return <ShellRetryExhaustedNotice />
	if (state === 'chat_unavailable') return <ShellChatUnavailableNotice />
	if (state === 'identity_pending') return <ShellIdentityPendingNotice />
	if (identityPending) return <ShellIdentityRetryNotice />
	if (pgpTemporary) return <ShellPgpTemporaryNotice />
	if (pgp) return <PgpRestoreFailedNotice code={pgp} />
	if (firstIdentity) return <PgpFirstIdentityNotice />
	return <>{children}</>
}

/**
 * The shared prompt for a blocked identity entry. Mounted once. It shows the not-ready hint with a retry action
 * and a close action. A disabled control that the user presses also raises it, when the shell blocks identity.
 */
import { useEffect, useState } from 'react'
import { tu } from '../locale/beamioLocale'
import { IDENTITY_ENTRY_PROMPT_EVENT } from '../services/identityEntryPrompt'
import { getNativeIdentityCapability, requestNativeIdentityRetry } from '../services/nativeIdentityProbeRetry'
import { shellChatBlockedNow } from '../services/shellChatCapability'

/**
 * The copy depends on the hello answer. Unanswered: the native side is not ready yet, so a retry can succeed.
 * Answered without identity.native-keys.v1: the shell does not support chat, so a retry cannot succeed and no retry is offered.
 */
type PromptMode = 'retry' | 'unavailable'

/** Presses on a disabled control reach the document; a blocked shell then raises the same prompt. */
const DISABLED_TARGET = 'button:disabled, input:disabled, select:disabled, textarea:disabled, [aria-disabled="true"]'

export default function IdentityEntryPrompt() {
	const [open, setOpen] = useState(false)
	const [mode, setMode] = useState<PromptMode>('retry')

	useEffect(() => {
		// the prompt state is set on the next turn: a blocked check may run during another component's render
		const onPrompt = () =>
			window.setTimeout(() => {
				setMode(getNativeIdentityCapability() === 'missing' ? 'unavailable' : 'retry')
				setOpen(true)
			}, 0)
		window.addEventListener(IDENTITY_ENTRY_PROMPT_EVENT, onPrompt)
		// the check runs synchronously inside the press, so the prompt rule sees the press event
		const onDisabledPress = (ev: Event) => {
			const target = ev.target as Element | null
			if (target && typeof target.closest === 'function' && target.closest(DISABLED_TARGET)) shellChatBlockedNow()
		}
		document.addEventListener('pointerdown', onDisabledPress, true)
		return () => {
			window.removeEventListener(IDENTITY_ENTRY_PROMPT_EVENT, onPrompt)
			document.removeEventListener('pointerdown', onDisabledPress, true)
		}
	}, [])

	if (!open) return null
	const unavailable = mode === 'unavailable'
	return (
		<div role="dialog" aria-modal="true" className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50 px-6">
			<div className="w-full max-w-sm rounded-3xl border border-white/15 bg-[#071126] p-6 text-center text-white shadow-2xl">
				{unavailable && <h2 className="text-base font-semibold">{tu('shell_chat_unavailable_title')}</h2>}
				<p className="mt-2 text-sm leading-6 text-white/85">{tu(unavailable ? 'shell_chat_unavailable_body' : 'native_not_ready_hint')}</p>
				<div className="mt-5 flex justify-center gap-3">
					{!unavailable && (
						<button
							type="button"
							onClick={() => {
								setOpen(false)
								requestNativeIdentityRetry()
							}}
							className="rounded-xl bg-[#2f80ed] px-4 py-2 text-sm font-medium text-white"
						>
							{tu('native_not_ready_retry_action')}
						</button>
					)}
					<button type="button" onClick={() => setOpen(false)} className="rounded-xl border border-white/25 px-4 py-2 text-sm text-white">
						{tu('close')}
					</button>
				</div>
			</div>
		</div>
	)
}

/**
 * The shared prompt for a blocked identity entry. Mounted once. It shows the not-ready hint with a retry action
 * and a close action. A disabled control that the user presses also raises it, when the shell blocks identity.
 */
import { useEffect, useRef, useState } from 'react'
import { tu } from '../locale/beamioLocale'
import { IDENTITY_ENTRY_PROMPT_EVENT, IDENTITY_READY_FLASH_MS, decideIdentityPrompt, readinessFeedbackOf } from '../services/identityEntryPrompt'
import { getNativeIdentityCapability, requestNativeIdentityRetry } from '../services/nativeIdentityProbeRetry'
import { shellChatBlockedNow } from '../services/shellChatCapability'
import { isShellChatLive } from '../services/shellChatLive'
import { useHelloWindowOpen, useVisibleReadPoll } from '../hooks/useHelloWait'

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
	// the visible readiness feedback (a silent retry is not a fix): waiting = a blocked press is being waited out; readyFlash = the chat turned live a moment ago
	const [waiting, setWaiting] = useState(false)
	const [readyFlash, setReadyFlash] = useState(false)
	const windowOpen = useHelloWindowOpen()
	// the dialog is visible: a read-only poll every 30 s while the window has run out; inside it the shared hello is already waiting
	useVisibleReadPoll(open && mode === 'retry' && !windowOpen)

	const firstBlockedAtRef = useRef<number | null>(null)
	const recheckRef = useRef<number | undefined>(undefined)
	useEffect(() => {
		// the prompt state is set on the next turn: a blocked check may run during another component's render
		const show = () => {
			// guard: a chat that is live proves the native side is ready, so a prompt that says it is not is never shown
			if (isShellChatLive()) { firstBlockedAtRef.current = null; return }
			setMode(getNativeIdentityCapability() === 'missing' ? 'unavailable' : 'retry')
			setWaiting(false)
			setOpen(true)
		}
		const onPrompt = () =>
			window.setTimeout(() => {
				if (isShellChatLive()) { firstBlockedAtRef.current = null; return }
				const now = Date.now()
				if (firstBlockedAtRef.current === null) firstBlockedAtRef.current = now
				// "waiting for the native identity": ask again silently, show only if the chat is still not live after the window (identityEntryPrompt.ts)
				const decision = decideIdentityPrompt({ now, firstBlockedAt: firstBlockedAtRef.current, unavailable: getNativeIdentityCapability() === 'missing' })
				if (decision.action === 'show') { show(); return }
				requestNativeIdentityRetry()
				setWaiting(true) // the press gets a visible answer at once: "preparing the wallet"
				if (recheckRef.current === undefined) {
					recheckRef.current = window.setTimeout(() => {
						recheckRef.current = undefined
						show()
					}, decision.recheckInMs)
				}
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
			if (recheckRef.current !== undefined) window.clearTimeout(recheckRef.current)
		}
	}, [])

	// the same guard for a prompt that is already open: it closes by itself once the chat is live (the root cause of the stale prompt is NOT found: this only keeps it from staying)
	useEffect(() => {
		if (!open) return
		const id = window.setInterval(() => {
			if (isShellChatLive()) setOpen(false)
		}, 1000)
		return () => window.clearInterval(id)
	}, [open])

	// while waiting, look for the chat turning live; then the status changes to "ready" for a moment and goes
	useEffect(() => {
		if (!waiting) return
		const id = window.setInterval(() => {
			if (!isShellChatLive()) return
			window.clearInterval(id)
			setWaiting(false)
			setReadyFlash(true)
		}, 500)
		return () => window.clearInterval(id)
	}, [waiting])
	// the "ready" line goes away by itself (its own timer: it must outlive the effect above, which ends when the wait ends)
	useEffect(() => {
		if (!readyFlash) return
		const id = window.setTimeout(() => setReadyFlash(false), IDENTITY_READY_FLASH_MS)
		return () => window.clearTimeout(id)
	}, [readyFlash])

	const live = isShellChatLive()
	const feedback = readinessFeedbackOf({ waiting, live, dialogOpen: open && !live, readyFlash })
	const status = feedback === 'none' ? null : (
		<div role="status" aria-live="polite" data-testid="identity-readiness-status" data-state={feedback} className="pointer-events-none fixed bottom-28 left-1/2 z-[1000] -translate-x-1/2 rounded-full border border-white/15 bg-[#071126] px-4 py-2 text-sm text-white shadow-lg">
			{tu(feedback === 'ready' ? 'native_wallet_ready' : 'native_preparing_wallet')}
		</div>
	)
	if (!open || live) return status
	const unavailable = mode === 'unavailable'
	return (
		<>
		{status}
		<div role="dialog" aria-modal="true" className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50 px-6">
			<div className="w-full max-w-sm rounded-3xl border border-white/15 bg-[#071126] p-6 text-center text-white shadow-2xl">
				{unavailable && <h2 className="text-base font-semibold">{tu('shell_chat_unavailable_title')}</h2>}
				<p className="mt-2 text-sm leading-6 text-white/85">{tu(unavailable ? 'shell_chat_unavailable_body' : windowOpen ? 'native_preparing_wallet' : 'native_not_ready_hint')}</p>
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
		</>
	)
}

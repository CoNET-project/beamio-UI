/**
 * History re-init after a passcode unlock.
 *
 * After a lock → unlock the chat start is run once, explicitly: the unlock callback calls `requestChatRestartAfterUnlock()`,
 * which runs the registered start (the App's `initChat(…, gossip=false, …)`) and claims the chat start for this unlock.
 * The App's `init()` asks `takeUnlockChatOwnership()` at the beginning of its run; when the claim is set the run skips its own
 * `initChat`, so the chat starts once whichever path runs first. The claim is consumed by the first `init()` run, so a
 * later run is never skipped by mistake.
 *
 * A lock does not stop the gossip listen (d62fb04b); the start after an unlock is the same reload as the foreground resume.
 */

type StartChat = () => Promise<void>

let startChat: StartChat | null = null
let claimed = false
let running: Promise<void> | null = null

/** the App registers its start while mounted (null on unmount). Nothing is claimed while no start is registered. */
export const registerUnlockChatRestart = (fn: StartChat | null): void => {
	startChat = fn
}

/**
 * Called by the unlock callback, synchronously, before `init()`. Returns false when no start is registered (the
 * caller's `init()` then runs its normal chat start). A second call while the start is running does not start it again.
 */
export const requestChatRestartAfterUnlock = (): boolean => {
	const fn = startChat
	if (!fn) return false
	claimed = true
	if (!running) {
		// a failing start is logged by the App's start; the claim is already consumed or set, so a failure never starts a second run here
		running = fn().catch(() => undefined).finally(() => {
			running = null
		})
	}
	return true
}

/**
 * The start after an unlock, with its dependencies injected (no App render needed to test the branch choice).
 *
 * - shell, native listen owned: the listen is resumed, never torn down; the gossip flag is set to the native state (on);
 * the history is reloaded once. No initChat.
 * - shell, native listen not owned: initChat(gossip=false) without prepareListenResume (no teardown of an existing listen).
 * - browser: the listen restarts as the foreground resume does, then initChat(gossip=false).
 *
 * Assumption (non-blocking): a native mailbox wake that arrives during this start is skipped by the foreground-resume guard;
 * the keep branch resumes the native listen, so the wake is covered there.
 */
export type UnlockChatStartDeps = {
	isShell: boolean
	resumeNativeListen: () => boolean
	reloadHistory: () => void
	setGossip: (v: boolean) => void
	prepareListenResume: (reason: string) => void
	initChat: (gossip: boolean) => Promise<void>
	log: (msg: string) => void
}

export const runUnlockChatStart = async (deps: UnlockChatStartDeps): Promise<void> => {
	if (deps.isShell) {
		if (deps.resumeNativeListen()) {
			deps.setGossip(true)
			deps.reloadHistory()
			deps.log('unlock: native listen kept, history reloaded (no teardown)')
			return
		}
		await deps.initChat(false)
		deps.log('unlock: chat start (native listen not owned, no teardown)')
		return
	}
	deps.prepareListenResume('passcode_unlock')
	deps.setGossip(false)
	await deps.initChat(false)
	deps.log('chat restarted after unlock (gossip off, single entry)')
}

/** True while the unlock restart's start is running. The foreground resume (chat.ts) skips its own restart meanwhile. */
export const isUnlockChatRestartRunning = (): boolean => running !== null

/** `init()` calls this first. True means the unlock restart owns the chat start: skip this run's `initChat`. Consumes the claim. */
export const takeUnlockChatOwnership = (): boolean => {
	const was = claimed
	claimed = false
	return was
}

/** test seam: the state of the module, reset between tests. */
export const resetUnlockChatRestartForTest = (): void => {
	startChat = null
	claimed = false
	running = null
}

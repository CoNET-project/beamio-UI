/**
 * The no-event watchdog of "setting up" (0.53.52). The shell declared identity.first.status.v1 and the page shows "setting up", but the SDK may stop talking
 * (a crash, a lost event). The page must not stay on "setting up" for ever: after the given time with no event it calls `onTimeout`, and the caller lands
 * on the failed notice ("the next start retries"). Every event restarts it; a terminal state or a pending notice clears it.
 */
export type FirstIdentityWatchdog = { arm: (ms: number) => void; clear: () => void; armed: () => boolean }

export function createFirstIdentityWatchdog(onTimeout: () => void): FirstIdentityWatchdog {
	let timer: ReturnType<typeof setTimeout> | undefined
	const clear = (): void => {
		if (timer !== undefined) clearTimeout(timer)
		timer = undefined
	}
	return {
		arm: (ms) => {
			clear()
			timer = setTimeout(() => {
				timer = undefined
				onTimeout()
			}, ms)
		},
		clear,
		armed: () => timer !== undefined,
	}
}

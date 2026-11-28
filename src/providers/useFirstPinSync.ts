import { useEffect, type Dispatch, type SetStateAction } from 'react'
import { FIRST_PIN_APPLIED_EVENT, applyPinnedToProfiles, type FirstPinAppliedDetail } from '@/services/peerRouteRecord'

/**
 * a first pinned value written to the stored record by a non-text path (services/chat.ts) is applied to the profile provider's state copy too
 * (see peerRouteRecord.ts). Without this listener the state copy never sees the pin, and a later write from that state would drop it. A hook of its own
 * so the wiring has a behavioural test: DaemonProvider calls it, and the test fails when the call or the listener is removed.
 */
export function useFirstPinSync(setProfilesState: Dispatch<SetStateAction<any>>): void {
	useEffect(() => {
		const onPinned = (e: Event) => {
			const d = (e as CustomEvent<FirstPinAppliedDetail>).detail
			if (!d || !d.address || !d.pinned) return
			setProfilesState((prev: any) => applyPinnedToProfiles(prev, d.address, d.pinned) as any)
		}
		window.addEventListener(FIRST_PIN_APPLIED_EVENT, onPinned)
		return () => window.removeEventListener(FIRST_PIN_APPLIED_EVENT, onPinned)
	}, [setProfilesState])
}

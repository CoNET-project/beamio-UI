/**
 * Late-arrival case: a native create or recovery page is open between its open and its ok (or
 * cancel, or unmount). While it is open the entry gate must not take over with the import route on a late no_key, or the
 * import route would cover the create or recovery page. The screens announce open and close; the gate listens.
 */
export const NATIVE_FLOW_PENDING_EVENT = 'beamio:native-flow-pending'

export function announceNativeFlowPending(open: boolean): void {
	if (typeof window === 'undefined') return
	window.dispatchEvent(new CustomEvent(NATIVE_FLOW_PENDING_EVENT, { detail: { open } }))
}

/** What the chat shows while the SDK sets up the first chat identity (QA builds): nothing, "setting up" (no button), or a failure (no button). */
export type FirstIdentitySetup = 'idle' | 'setting_up' | 'failed'
let value: FirstIdentitySetup = 'idle'
const listeners = new Set<(v: FirstIdentitySetup) => void>()
export function getFirstIdentitySetup(): FirstIdentitySetup {
	return value
}
export function setFirstIdentitySetup(next: FirstIdentitySetup): void {
	if (next === value) return
	value = next
	for (const l of [...listeners]) l(next)
}
export function subscribeFirstIdentitySetup(l: (v: FirstIdentitySetup) => void): () => void {
	listeners.add(l)
	return () => {
		listeners.delete(l)
	}
}

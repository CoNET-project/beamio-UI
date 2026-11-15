/**
 * The update prompt, raised when the native layer refuses this page's build (`origin_refused` on a shell record command). A background
 * write has no screen of its own, so it raises this event and the entry gate shows the same update screen as a refused read.
 */
export const APP_UPDATE_REQUIRED_EVENT = 'beamioAppUpdateRequired'

export function notifyAppUpdateRequired(): void {
	if (typeof window === 'undefined') return
	window.dispatchEvent(new Event(APP_UPDATE_REQUIRED_EVENT))
}

export function onAppUpdateRequired(listener: () => void): () => void {
	if (typeof window === 'undefined') return () => {}
	window.addEventListener(APP_UPDATE_REQUIRED_EVENT, listener)
	return () => window.removeEventListener(APP_UPDATE_REQUIRED_EVENT, listener)
}

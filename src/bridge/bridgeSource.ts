/**
 * Bridge source rule: a bridge message is accepted only when it comes from the main frame
 * and its origin is exactly the shell origin. Everything else is dropped before any command runs.
 *
 * Pure functions. The shell origin is passed in; the page's own origin is the default in the browser (to be confirmed by
 * the interface owner for each shell).
 */
export interface BridgeSource {
	isMainFrame: boolean
	origin: string
}

export function isTrustedBridgeSource(src: BridgeSource, shellOrigin: string): boolean {
	return src.isMainFrame === true && src.origin === shellOrigin
}

/**
 * The source of a window message as seen by the receiving window: main frame only, when this window is the top window
 * and the message does not come from a child frame (its `source` is absent or the top window itself).
 */
export function bridgeSourceOf(
	event: { origin: string; source: unknown },
	win: { self: unknown; top: unknown },
): BridgeSource {
	const isMainFrame = win.self === win.top && (event.source == null || event.source === win.top)
	return { isMainFrame, origin: event.origin }
}

/** The page's shell origin in the browser. */
export const SHELL_ORIGIN = typeof window !== 'undefined' ? window.location.origin : ''

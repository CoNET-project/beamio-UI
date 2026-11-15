/**
 * Bridge source rule: a bridge message is accepted only when it comes from the main frame and its origin is exactly one of
 * the real shell origins (an explicit allowlist). The page's own origin is never the base of the check.
 * An opaque or empty origin is refused in every case. Everything else is dropped before any command runs.
 *
 * Pure functions.
 */
export interface BridgeSource {
	isMainFrame: boolean
	origin: string
}

/** The real shell origins: iOS (custom scheme) and Android (app assets). Exact strings, no trailing slash. */
export const SHELL_ORIGINS: readonly string[] = ['cashtrees-local://localhost', 'https://appassets.androidplatform.net']

/** Exact match against one shell origin. An empty or opaque expected origin never matches. */
export function isTrustedBridgeSource(src: BridgeSource, shellOrigin: string): boolean {
	if (!shellOrigin || shellOrigin === 'null') return false
	return src.isMainFrame === true && src.origin === shellOrigin
}

/** The origin is one of the explicit shell origins. `null`, an empty value and any other value are refused. */
export function isExplicitShellOrigin(origin: string): boolean {
	if (typeof origin !== 'string' || origin === '' || origin === 'null') return false
	return SHELL_ORIGINS.includes(origin)
}

/** The inbound rule of the shell bridge: the main frame, and an origin from the explicit allowlist. */
export function isTrustedShellSource(src: BridgeSource): boolean {
	return src.isMainFrame === true && isExplicitShellOrigin(src.origin)
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


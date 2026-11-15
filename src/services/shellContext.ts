/**
 * The shell test: a shell build or a page with the native bridge. Kept dependency-free so that
 * the wallet core, the vault, the global state and the chat can all import it without a cycle.
 */
import { isShellBuildKind } from '../utils/shellBuildFlag'
import { isCashTreesNativeWebView } from '../utils/cashTreesNativeNfc'

export function isShellContext(): boolean {
	return isShellBuildKind() || isCashTreesNativeWebView()
}

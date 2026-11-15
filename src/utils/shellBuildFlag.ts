/**
 * Shell build marker. A native shell builds the PWA with `REACT_APP_SHELL_BUILD=true`. A shell build never
 * takes the page-key path, even when the native bridge is missing. The flag's name and where the shell build sets it are
 * for the PWA integration owner to confirm (SHELL-BUILD-FLAG).
 */
export function isShellBuildKind(): boolean {
	return process.env.REACT_APP_SHELL_BUILD === 'true'
}

/**
 * Whether the wallet passcode is on, kept in step with the store. `null` until the first read finishes.
 * Re-reads on PASSCODE_STATE_EVENT, which the passcode setters dispatch on every successful set, disable or wipe.
 * `enabled: false` skips the read and the listener (the native shell keeps the passcode in its own keystore UI); returns null.
 */
import { useEffect, useState } from 'react'
import { walletVaultHasPasscode } from '../../services/beamio'
import { PASSCODE_STATE_EVENT } from '../../services/walletVaultEvents'

export function usePasscodeEnabled(enabled = true): boolean | null {
	const [on, setOn] = useState<boolean | null>(null)
	useEffect(() => {
		if (!enabled) return
		let alive = true
		const refresh = () => {
			void walletVaultHasPasscode().then((v) => {
				if (alive) setOn(v)
			})
		}
		refresh()
		window.addEventListener(PASSCODE_STATE_EVENT, refresh)
		return () => {
			alive = false
			window.removeEventListener(PASSCODE_STATE_EVENT, refresh)
		}
	}, [enabled])
	return enabled ? on : null
}

/**
 * Identity entries in a shell without the chat capability are disabled (spec, option A; G2). Every entry reads
 * this one hook, so the rule is stated once. A browser build is never disabled. The hook follows the shell's chat UI state, so
 * an entry turns on when the shell's hello answer declares `identity.native-keys.v1`.
 */
import { useEffect, useState } from 'react'
import { getShellChatUiState, subscribeShellChatUiState } from '../services/shellChatUiState'
import { isShellContext, shellChatBlocked } from '../services/shellChatCapability'

export function useIdentityEntryDisabled(): boolean {
	const [state, setState] = useState(() => getShellChatUiState())
	useEffect(() => subscribeShellChatUiState(setState), [])
	return shellChatBlocked({ shell: isShellContext(), state })
}

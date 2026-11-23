/**
 * React boundary for the chat page (unit e). While the UI is locked the children are not rendered, so the chat interface
 * mounts nothing and starts no read. The guard state is the only input (chatAccessGuard.ts).
 */
import { useSyncExternalStore, type ReactNode } from 'react'
import { getChatAccessState, subscribeChatAccess } from './chatAccessGuard'

export function ChatAccessBoundary({ children }: { children: ReactNode }) {
	const { locked } = useSyncExternalStore(subscribeChatAccess, getChatAccessState, getChatAccessState)
	if (locked) return <div data-testid="chat-access-locked" />
	return <>{children}</>
}

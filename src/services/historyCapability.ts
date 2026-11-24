/**
 * Whether the active chat client has a page-side local conversation library (`openConversation` / `loadOlder`).
 * The native shell clients (iOS, Android) do not: their `openConversation` is a stub that always throws, and the history of a shell comes
 * from the native `historyRead` / `historyLoad`. The page therefore does not judge the history "unreadable" from that stub:
 * a client without the library answers `not_ready` (no notice), never a read error. Declared here by name, not by matching an error text.
 */
export const NATIVE_CLIENT_HAS_LOCAL_LIBRARY = false

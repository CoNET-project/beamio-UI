/**
 * The SDK worker entry. The package's `./worker` export is resolved at bundle time; this declaration gives the named start function
 * its type for this project's TypeScript resolution. The function is the only export the wrapper uses; it has no import-time side effect.
 */
declare module '@conet.project/chat-sdk/worker' {
	export function startChatWorkerEntry(): void
}

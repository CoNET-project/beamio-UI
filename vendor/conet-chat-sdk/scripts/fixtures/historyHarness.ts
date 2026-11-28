/** test doubles shared by the history scripts: an account lock shared by every "tab" over one persistence map, and the publish snapshot of a stubbed chain */
const chains = new WeakMap<object, Promise<unknown>>()
export const sharedLockFor = (shared: object) => <T>(name: string, fn: () => Promise<T>): Promise<T> => {
	void name
	const run = (chains.get(shared) ?? Promise.resolve()).catch(() => undefined).then(fn)
	chains.set(shared, run.catch(() => undefined))
	return run
}

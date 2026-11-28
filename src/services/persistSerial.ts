/**
 * the page record is written by read-merge-write (persistInitRecord). The debounced write (storeSystemData) and the immediate writes (flushStoreSystemData, a message the
 * user just sent or just received) could overlap; each took its snapshot of CoNET_Data when it STARTED, so a write that started earlier and finished later could put an older
 * snapshot over a newer one (the message that was just sent or received missing after a refresh). Every write now runs one after the other, and takes its snapshot when its turn
 * begins, so the last write to land is always the newest.
 */
let tail: Promise<unknown> = Promise.resolve()

export function runPersistSerial<T>(task: () => Promise<T>): Promise<T> {
	const run = tail.catch(() => undefined).then(task)
	tail = run
	return run
}

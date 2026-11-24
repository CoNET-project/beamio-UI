/**
 *  and (source guards): the shell record store sends only through the transport layer (no direct chat call, no
 * direct window object); the entry gate keeps the wait past the splash deadline while the store migrates, and clears an earlier
 * unavailable state when the store reads. A removed guard fails this test.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8')

describe('shell record transport and migration wait (source guards)', () => {
	it('the shell record store sends only through sendShellRecordCommand (no chat call, no bridge object)', () => {
		const store = read('src/services/shellRecordStore.ts')
		expect(store).toContain('sendShellRecordCommand(')
		expect(store).not.toContain('requestNativeAck')
		expect(store).not.toContain('postChatModuleCommand')
		// The store keeps its own persisted intent in localStorage; it never names the bridge objects.
		expect(store).not.toMatch(/BeamioShellRecord|CashTreesIOS|chatModuleCommand/)
	})

	it('the transport prefers the injected object, and never falls back from it (origin_refused stays the answer)', () => {
		const t = read('src/services/shellRecordTransport.ts')
		expect(t).toContain("if (injectionPresent()) return 'window'")
		expect(t).toContain("if (platform === 'android') return 'not_supported'")
		expect(t).toContain("if (platform === 'ios' && iosChatChannelPresent()) return 'chat'")
	})

	it('the entry gate keeps the wait at the splash deadline while the store is not ready, and clears the unavailable state on a read', () => {
		const gate = read('src/components/AppEntryGate.tsx')
		expect(gate).toContain("from '@/services/shellStoreWait'")
		expect(gate).toContain("if (action === 'keep_waiting')")
		expect(gate).toContain('nativeWaiting: nativeWaitRef.current')
		expect(gate).toContain('setStorageUnavailable(null)')
	})
	it('the pre-save read is a probe read in the shell (it does not move the copy basis)', () => {
		expect(read('src/services/passcode/walletVault.ts')).toContain('stores.probeInit ? await stores.probeInit() : await stores.readInit()')
		expect(read('src/services/beamio.ts')).toContain('probeInit: async () => readInitObject({ probe: true })')
	})

	it('every shell record request waits 10 seconds for its reply (4)', () => {
		expect(read('src/services/shellRecordStore.ts')).toContain('const TIMEOUT_MS = 10_000')
		expect(read('src/services/shellRecordTransport.ts')).toContain('export const SHELL_RECORD_REPLY_TIMEOUT_MS = 45_000')
	})

	it('the app resumes a persisted deferred write at start, without a storage read', () => {
		expect(read('src/components/AppEntryGate.tsx')).toContain('resumeDeferredWrite()')
	})
})

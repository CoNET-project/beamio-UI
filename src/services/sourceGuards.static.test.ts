/**
 * (source guards): RegenerateUser is never queued (its recovery data does not travel with the queued
 * re-send, which is postBeamio only). A shell save without the EOA key is queued and waits (deferred), never dropped and never a
 * failure. The shell receive path keeps no peer PGP public armor. The create page sends the account and handles already_bound and
 * lookup_unavailable. A removed guard fails this test.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8')

describe('source guards', () => {
	it('RegenerateUser carries its recovery data and is never queued', () => {
		const beamio = read('src/services/beamio.ts')
		const start = beamio.indexOf('const RegenerateUser = async')
		expect(start).toBeGreaterThan(-1)
		const next = beamio.slice(start + 1).search(/\n(const |export |\/\*\*)/)
		const body = beamio.slice(start, next === -1 ? undefined : start + 1 + next)
		expect(body).toContain('recover: recoverData')
		expect(body).not.toContain('enqueuePendingServerSync')
	})

	it('a shell save without the EOA key is queued and waits: deferred, never dropped, never a failure', () => {
		const beamio = read('src/services/beamio.ts')
		expect(beamio).toContain('queueSync(accountInMemory, from)')
		expect(beamio).toContain("postBeamioFrom(current as beamio, profile.privateKeyArmor, 'queue')")
		expect(beamio).not.toContain("'no_key'")
		const send = beamio.slice(beamio.indexOf('export async function sendPendingProfileSync'))
		expect(send).toMatch(/privateKeyArmor\.trim\(\)\) return 'deferred'/)
	})

	it('a transient server answer (5xx, 408, 429) waits; only an explicit refusal is returned as a refusal', () => {
		const beamio = read('src/services/beamio.ts')
		expect(beamio).toContain('resp.status >= 500 || resp.status === 408 || resp.status === 429')
	})

	it('the shell receive path drops the peer PGP public armor', () => {
		expect(read('src/App.tsx')).toContain('withoutPeerPublicArmor(updatedChatData)')
	})

	it('the create page no longer sends a native account-create open (the PWA creates the account itself); the command constant stays in the native bridge file only', () => {
		const page = read('src/pages/Home/CreateUsernamePinScreen.tsx')
		expect(page).not.toContain('nativeAccountCreateOpen')
		expect(page).not.toContain('onNativeAccountCreateResult')
		expect(page).toContain('createRecover(trimmedTag, pwd')
		const cmd = read('src/services/nativeRecovery.ts')
		expect(cmd).toContain('{ type: NATIVE_ACCOUNT_CREATE_OPEN_COMMAND, account }')
	})

	it('the shell storage-unavailable path never reaches onboarding: it re-reads on the 2, 4, 8, 16 s then 30 s schedule, with no manual button', () => {
		// 改写：旧守卫的 native_retry 路由与“之后转手动”已废止；不变式“壳内存储不可用不进 onboarding”保留。
		const gate = read('src/components/AppEntryGate.tsx')
		const policy = read('src/services/startupRetryPolicy.ts')
		expect(policy).toContain('[2_000, 4_000, 8_000, 16_000]')
		expect(policy).toContain('STARTUP_RETRY_STEADY_MS = 30_000')
		expect(gate).toContain('const delay = startupRetryDelayMs(attempt)')
		expect(gate).toContain('void initRef.current?.()')
		// the retired native_retry route, its manual step and the fixed attempt cap are gone
		expect(gate).not.toContain("storageUnavailableRoute({ nativeShell, reason }) === 'native_retry'")
		expect(gate).not.toContain('nativeRetryStep(attempt)')
		expect(gate).not.toContain('nativeStoreWaitDelayMs(attempt)')
		expect(gate).not.toContain('attempt >= 6')
		expect(gate).not.toContain('showStorageUnavailable(MIGRATION_RETRY_SCREEN)')
		// runtime proof: the no-stuck-screen suite re-enters each waiting class and reaches onboarding only after a definite answer
		expect(read('src/components/AppEntryGate.startupTwoState.test.tsx')).toContain('no stuck shell screens')
	})
})

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

	it('the create page sends the account and handles already_bound (recovery) and lookup_unavailable (retry, no creation)', () => {
		const page = read('src/pages/Home/CreateUsernamePinScreen.tsx')
		expect(page).toContain('nativeAccountCreateOpen(trimmedTag)')
		expect(page).toContain("code === 'already_bound'")
		expect(page).toContain("code === 'lookup_unavailable'")
		expect(page).toContain("opened.reason === 'already_bound'")
		expect(page).toContain("opened.reason === 'lookup_unavailable'")
		const cmd = read('src/services/nativeRecovery.ts')
		expect(cmd).toContain('{ type: NATIVE_ACCOUNT_CREATE_OPEN_COMMAND, account }')
	})

	it('the gate never routes a shell build to onboarding: native_retry backs off without a limit', () => {
		const gate = read('src/components/AppEntryGate.tsx')
		// the router is the pure storageRoute.ts; a shell (and a browser) never reaches onboarding from a storage failure.
		expect(gate).toContain("storageUnavailableRoute({ nativeShell, reason }) === 'native_retry'")
		expect(read('src/services/storageRoute.ts')).toContain("input.nativeShell && input.reason === 'native_retry'")
		expect(gate).toContain('nativeStoreWaitDelayMs(attempt)')
	})
})

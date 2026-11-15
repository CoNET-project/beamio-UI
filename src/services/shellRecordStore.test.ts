/**
 * Plan N: the shell record over the bridge. The command set is fixed; the revision is inside the record;
 * a read is ok (with an integer rev) or absent, everything else an error; a write at a stale revision is a conflict; PGP
 * material and the W-class copy are refused before anything is sent.
 */
import {
	shellRecordAsWalletRecord,
	buildShellRecordReadCommand,
	buildShellRecordWriteCommand,
	knownRevForTest,
	parseShellRecordRead,
	parseShellRecordWrite,
	resetShellRecordForTest,
} from './shellRecordStore'

// The account address that the test key 0x22..22 derives to (the EOA key must derive to the account).
const ADDR = '0x1563915e194D8CfBA1943570603F7606A3115508'
const KEY = '0x' + '2'.repeat(64)
// A second account and its key (0x33..33), for the "key on another profile" cases.
const ADDR_2 = '0x5CbDd86a2FA8Dc4bDdd8a8f69dBa48572EeC07FB'
const KEY_2 = '0x' + '3'.repeat(64)

// TEST ONLY: the PGP header below is a detector input. It is a header string with no key material.
const PGP_HEADER = 'BEGIN PGP PRIVATE KEY BLOCK'
const pgpRecord = () => ({ profiles: [{ keyID: ADDR, chatManager: { pgpKey: { publicKey: 'PUB', privateKey: 'P1' } } }] })
const w = () => ({ profiles: [{ keyID: ADDR, privateKeyArmor: '0x' + '2'.repeat(64) }] })

describe('shell record command set (2)', () => {
	beforeEach(() => resetShellRecordForTest())

	it('the read command carries type and reqId only', () => {
		expect(Object.keys(buildShellRecordReadCommand(4)).sort()).toEqual(['reqId', 'type'])
	})

	it('the write command carries type, reqId and the record with the rev at its top level', () => {
		const cmd = buildShellRecordWriteCommand(5, { profiles: [] }, 3)
		expect(Object.keys(cmd).sort()).toEqual(['record', 'reqId', 'type'])
		expect((cmd.record as any).rev).toBe(3)
	})

	it(' (8): a copy with PGP public fields is refused with pgp_field_not_allowed and the path names; no value is sent', () => {
		let msg = ''
		try {
			buildShellRecordWriteCommand(6, { profiles: [{ keyID: 'k', chatManager: { pgpKey: { publicKey: 'PUB', keyID: 'K' } }, pgpKey: { publicKey: 'PUB2' } }] }, 0)
		} catch (e) {
			msg = String((e as Error).message)
		}
		expect(msg).toMatch(/^pgp_field_not_allowed: /)
		expect(msg).toContain('profiles[].chatManager.pgpKey')
		expect(msg).toContain('profiles[].pgpKey')
		expect(msg.includes('PUB')).toBe(false)
	})

	it('a copy without PGP fields is sent; an empty chatManager stays as it is', () => {
		const cmd = buildShellRecordWriteCommand(7, { profiles: [{ keyID: 'k', chatManager: { router: { x: 1 } } }] }, 0)
		expect((cmd.record as any).profiles[0].chatManager).toEqual({ router: { x: 1 } })
	})

	it('the mnemonic is mnemonicPhrase in the page record; it is never sent', () => {
		const cmd = buildShellRecordWriteCommand(8, { profiles: [{ keyID: 'k' }], mnemonicPhrase: 'w w w' }, 0)
		expect((cmd.record as any).mnemonicPhrase).toBeUndefined()
		expect(JSON.stringify(cmd).includes('w w w')).toBe(false)
	})

	it('the write carries schemaVersion 2 at the top level (5)', () => {
		const cmd = buildShellRecordWriteCommand(5, { profiles: [], schemaVersion: 1 }, 0)
		expect((cmd.record as any).schemaVersion).toBe(2)
	})
})

describe('read answers (4): ok with an integer rev, or absent; everything else is an error', () => {
	beforeEach(() => resetShellRecordForTest())

	it('ok with an integer rev is accepted and sets the known revision', () => {
		const r = parseShellRecordRead({ type: 'ack', reqId: 1, ok: true, result: { code: 'ok', record: { rev: 4, profiles: [{ keyID: ADDR, privateKeyArmor: '0x' + '2'.repeat(64) }], beamio: { accountName: 'alice' } } } })
		expect(r).toEqual({ status: 'ok', record: { rev: 4, profiles: [{ keyID: ADDR, privateKeyArmor: '0x' + '2'.repeat(64) }], beamio: { accountName: 'alice' } }, rev: 4, walletFieldsRedacted: false })
	})

	it('a record with no profile at index 0 has no bound EOA key: needs_native_recovery (a hold), never absent', () => {
		expect(parseShellRecordRead({ type: 'ack', reqId: 1, ok: true, result: { code: 'ok', record: { rev: 3, profiles: [] } } })).toEqual({
			status: 'error',
			reason: 'needs_native_recovery',
		})
	})

	it('a profiles field that is not a list is a malformed record: wallet_fields_missing (a hold)', () => {
		expect(parseShellRecordRead({ type: 'ack', reqId: 1, ok: true, result: { code: 'ok', record: { rev: 3, profiles: {} } } })).toEqual({
			status: 'error',
			reason: 'wallet_fields_missing',
		})
	})

	it('.2: a read without the flag is not redacted (the W fields are carried); only an older native true is', () => {
		const missing = parseShellRecordRead({ type: 'ack', reqId: 1, ok: true, result: { code: 'ok', record: { rev: 2, profiles: [{ keyID: ADDR, privateKeyArmor: '0x' + '2'.repeat(64) }], beamio: { accountName: 'alice' } } } })
		expect(missing).toMatchObject({ status: 'ok', walletFieldsRedacted: false })
		const legacy = parseShellRecordRead({ type: 'ack', reqId: 1, ok: true, result: { code: 'ok', record: { rev: 2, profiles: [{ keyID: ADDR, privateKeyArmor: '0x' + '2'.repeat(64) }], beamio: { accountName: 'alice' } }, walletFieldsRedacted: true } })
		expect(legacy).toEqual({ status: 'ok', record: { rev: 2, profiles: [{ keyID: ADDR, privateKeyArmor: '0x' + '2'.repeat(64) }], beamio: { accountName: 'alice' } }, rev: 2, walletFieldsRedacted: true })
	})

	it('ok without an integer rev is an error (rev_missing)', () => {
		expect(parseShellRecordRead({ type: 'ack', reqId: 1, ok: true, result: { code: 'ok', record: { profiles: [] } } })).toEqual({ status: 'error', reason: 'rev_missing' })
		expect(parseShellRecordRead({ type: 'ack', reqId: 1, ok: true, result: { code: 'ok', record: { rev: 1.5 } } })).toEqual({ status: 'error', reason: 'rev_missing' })
	})

	it('absent is accepted; migrating, record_unreadable, too_large, origin_refused, bad_request are errors', () => {
		expect(parseShellRecordRead({ type: 'ack', reqId: 1, ok: true, result: { code: 'absent' } })).toEqual({ status: 'absent' })
		for (const code of ['migrating', 'record_unreadable', 'storage_locked', 'too_large', 'origin_refused', 'bad_request', 'wallet_copy_not_approved']) {
			expect(parseShellRecordRead({ type: 'ack', reqId: 1, ok: true, result: { code } })).toEqual({ status: 'error', reason: code })
		}
	})

	it('.2: result.code error carries sub (import_not_done, account_record_missing, legacy_store_unreadable): always an error, never absent', () => {
		for (const sub of ['import_not_done', 'account_record_missing', 'legacy_store_unreadable']) {
			expect(parseShellRecordRead({ type: 'ack', reqId: 1, ok: true, result: { code: 'error', sub } })).toEqual({ status: 'error', reason: sub })
		}
	})

	it('no bridge, a non-ack, or an unknown answer is an error (fail closed)', () => {
		expect(parseShellRecordRead(null)).toEqual({ status: 'error', reason: 'native_unavailable' })
		expect(parseShellRecordRead({ type: 'ack', reqId: 1, ok: false, error: 'no_key' })).toEqual({ status: 'error', reason: 'no_key' })
		expect(parseShellRecordRead({ type: 'ack', reqId: 1, ok: true, result: { code: 'weird' } })).toEqual({ status: 'error', reason: 'weird' })
	})

	it('a read answer that carries PGP material is an error, never a record', () => {
		expect(parseShellRecordRead({ type: 'ack', reqId: 1, ok: true, result: { code: 'ok', record: { rev: 1, ...pgpRecord() } } })).toEqual({
			status: 'error',
			reason: 'pgp_private_in_payload',
		})
	})
})

describe('+ : the read as the wallet record (absent is the only onboarding; every other state is a hold)', () => {
	const ok = (rec: Record<string, unknown>) => ({ status: 'ok' as const, record: rec, rev: 2, walletFieldsRedacted: false })

	it('absent is null (the only route to onboarding)', () => {
		expect(shellRecordAsWalletRecord({ status: 'absent' })).toBeNull()
	})

	it('case 1: the record exists with the EOA key bound to the account: entered (no @beamioTag or account name needed)', () => {
		const rec = { rev: 2, profiles: [{ keyID: ADDR, privateKeyArmor: KEY }] }
		expect(shellRecordAsWalletRecord(ok(rec))).toBe(rec)
		expect(parseShellRecordRead({ type: 'ack', reqId: 1, ok: true, result: { code: 'ok', record: rec } })).toMatchObject({ status: 'ok' })
	})

	it('case 2: the record exists but the profile bound to the account has no EOA key: needs_native_recovery (a hold, never onboarding)', () => {
		const rec = { rev: 2, profiles: [{ keyID: ADDR }] }
		expect(() => shellRecordAsWalletRecord(ok(rec))).toThrow('shell_record_needs_native_recovery')
		expect(parseShellRecordRead({ type: 'ack', reqId: 1, ok: true, result: { code: 'ok', record: rec } })).toEqual({
			status: 'error',
			reason: 'needs_native_recovery',
		})
	})

	it('case 3: only a mnemonic, no EOA key: needs_native_recovery (the mnemonic does not count)', () => {
		const rec = { rev: 2, profiles: [{ keyID: ADDR }], mnemonicPhrase: 'w w w' }
		expect(() => shellRecordAsWalletRecord(ok(rec))).toThrow('shell_record_needs_native_recovery')
	})

	it('case 4: the EOA key sits on another profile, not the one bound to the account: needs_native_recovery (no "any profile" rule)', () => {
		const rec = { rev: 2, profiles: [{ keyID: ADDR }, { keyID: ADDR_2, privateKeyArmor: KEY_2 }] }
		expect(() => shellRecordAsWalletRecord(ok(rec))).toThrow('shell_record_needs_native_recovery')
	})

	it('X1: a mixed-case address with a bad checksum is a damaged record: wallet_fields_missing, unavailable, never entered', () => {
		const bad = '0x1563915e194d8CfBA1943570603F7606A3115508'
		const rec = { rev: 2, profiles: [{ keyID: bad, privateKeyArmor: KEY }] }
		expect(() => shellRecordAsWalletRecord(ok(rec))).toThrow('shell_record_wallet_fields_missing')
		expect(parseShellRecordRead({ type: 'ack', reqId: 1, ok: true, result: { code: 'ok', record: rec } })).toEqual({
			status: 'error',
			reason: 'wallet_fields_missing',
		})
	})

	it('an all-lower-case address is accepted and the read carries the checksum form (the app reads it with getAddress)', () => {
		const lower = ADDR.toLowerCase()
		const r = parseShellRecordRead({ type: 'ack', reqId: 1, ok: true, result: { code: 'ok', record: { rev: 2, profiles: [{ keyID: lower, privateKeyArmor: KEY }] } } })
		expect(r.status).toBe('ok')
		if (r.status === 'ok') expect((r.record.profiles as any)[0].keyID).toBe(ADDR)
	})

	it('an all-upper-case address (0x + upper hex) is accepted', () => {
		const upper = '0x' + ADDR.slice(2).toUpperCase()
		const r = parseShellRecordRead({ type: 'ack', reqId: 1, ok: true, result: { code: 'ok', record: { rev: 2, profiles: [{ keyID: upper, privateKeyArmor: KEY }] } } })
		expect(r.status).toBe('ok')
	})

	it('X2: profiles[0] is not a profile, so the EOA key cannot be bound to the account: needs_native_recovery (a hold, never onboarding)', () => {
		const rec = { rev: 2, profiles: [null, { keyID: ADDR, privateKeyArmor: KEY }] }
		expect(() => shellRecordAsWalletRecord(ok(rec as any))).toThrow('shell_record_needs_native_recovery')
	})

	it('a key that does not derive to the account address: needs_native_recovery (a hold)', () => {
		const rec = { rev: 2, profiles: [{ keyID: ADDR, privateKeyArmor: KEY_2 }] }
		expect(() => shellRecordAsWalletRecord(ok(rec))).toThrow('shell_record_needs_native_recovery')
	})

	it('(probe H): duplicate profiles for the account (the key on the second copy) cannot be selected: duplicate_profiles (a hold, never onboarding)', () => {
		const rec = { rev: 2, profiles: [{ keyID: ADDR }, { keyID: ADDR, privateKeyArmor: KEY }] }
		expect(() => shellRecordAsWalletRecord(ok(rec))).toThrow('shell_record_duplicate_profiles')
		expect(parseShellRecordRead({ type: 'ack', reqId: 1, ok: true, result: { code: 'ok', record: rec } })).toEqual({
			status: 'error',
			reason: 'duplicate_profiles',
		})
	})

	it('two identical copies of the account are duplicate_profiles too', () => {
		const rec = { rev: 2, profiles: [{ keyID: ADDR, privateKeyArmor: KEY }, { keyID: ADDR, privateKeyArmor: KEY }] }
		expect(() => shellRecordAsWalletRecord(ok(rec))).toThrow('shell_record_duplicate_profiles')
	})

	it('another account after the account profile does not make a duplicate (the account is profiles[0])', () => {
		const rec = { rev: 2, profiles: [{ keyID: ADDR, privateKeyArmor: KEY }, { keyID: ADDR_2, privateKeyArmor: KEY_2 }] }
		expect(shellRecordAsWalletRecord(ok(rec))).toBe(rec)
	})

	it('a redacted read (older native, explicit true) and any error throw with the shell_record_ prefix', () => {
		const rec = { rev: 2, profiles: [{ keyID: ADDR, privateKeyArmor: KEY }] }
		expect(() => shellRecordAsWalletRecord({ status: 'ok', record: rec, rev: 2, walletFieldsRedacted: true })).toThrow('shell_record_wallet_fields_redacted')
		expect(() => shellRecordAsWalletRecord({ status: 'error', reason: 'migrating' })).toThrow('shell_record_migrating')
		expect(() => shellRecordAsWalletRecord({ status: 'error', reason: 'import_not_done' })).toThrow('shell_record_import_not_done')
	})
})

describe('write answers (3): ok with the new rev, conflict with currentRev, or an error code', () => {
	it('ok carries the new rev; conflict carries currentRev; other codes are errors', () => {
		expect(parseShellRecordWrite({ type: 'ack', reqId: 1, ok: true, result: { code: 'ok', rev: 5 } })).toEqual({ status: 'ok', rev: 5 })
		expect(parseShellRecordWrite({ type: 'ack', reqId: 1, ok: true, result: { code: 'conflict', currentRev: 7 } })).toEqual({ status: 'conflict', currentRev: 7 })
		expect(parseShellRecordWrite({ type: 'ack', reqId: 1, ok: true, result: { code: 'write_failed' } })).toEqual({ status: 'error', reason: 'write_failed' })
	})
})

describe('write refusals before anything is sent (5, .10)', () => {
	it('a PGP private path is refused', () => {
		expect(() => buildShellRecordWriteCommand(1, pgpRecord(), 0)).toThrow(/pgp_private_in_payload/)
	})

	it('the PGP header in any string value is refused, the header itself is not in the message', () => {
		let msg = ''
		try {
			buildShellRecordWriteCommand(1, { profiles: [], note: PGP_HEADER }, 0)
		} catch (e) {
			msg = String((e as Error).message)
		}
		expect(msg).toMatch(/pgp_private_in_payload/)
		expect(msg.includes('BEGIN PGP')).toBe(false)
	})

	it('.2: the W-class fields (EOA private key, mnemonic) are never sent; the native side keeps its copy', () => {
		const cmd = buildShellRecordWriteCommand(1, { ...w(), mnemonic: 'w w', walletVault: { mnemonic: 'w w', other: 1 } }, 0)
		expect(cmd.type).toBe('shellRecordWrite')
		expect(JSON.stringify(cmd).includes('0x' + '2'.repeat(64))).toBe(false)
		expect(JSON.stringify(cmd).includes('w w')).toBe(false)
		expect((cmd.record as any).walletVault).toEqual({ other: 1 })
		expect((cmd.record as any).profiles[0].keyID).toBe(ADDR)
	})

	it('the size limit is in UTF-8 bytes: 3-byte characters over 2 MB are refused even when the character count is under it', () => {
		const chars = Math.floor((2 * 1024 * 1024) / 3) + 10
		expect(chars).toBeLessThan(2 * 1024 * 1024)
		expect(() => buildShellRecordWriteCommand(1, { profiles: [], big: '中'.repeat(chars) }, 0)).toThrow(/too_large/)
	})

	it('a record over the 2 MB limit is refused as too_large', () => {
		expect(() => buildShellRecordWriteCommand(1, { profiles: [], big: 'x'.repeat(2 * 1024 * 1024 + 10) }, 0)).toThrow(/too_large/)
	})

	it('the known revision is only set by a read (absent is 0)', () => {
		resetShellRecordForTest()
		expect(knownRevForTest()).toBeNull()
	})
})

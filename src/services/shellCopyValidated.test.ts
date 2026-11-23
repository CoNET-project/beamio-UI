/**
 * @jest-environment node
 */
/**
 * r92 step 3 (draft 21.6 to 21.8, 22.3, 22.4): the native check of a page copy (copyValidated, eoa), the isolation command of a
 * key-only copy, and the fresh-write guard. The transport is mocked; no key material is used beyond the test key 0x22..22.
 */
import { sendShellRecordCommand, type ShellRecordAnswer } from './shellRecordTransport'
import {
	parseShellRecordRead,
	parseQuarantineAnswer,
	quarantineKeyOnlyShellRecord,
	validatedCopyAccount,
	prepareShellFreshWrite,
	resetShellRecordForTest,
	SHELL_RECORD_QUARANTINE_KEY_ONLY,
} from './shellRecordStore'

jest.mock('./shellRecordTransport', () => {
	const actual = jest.requireActual('./shellRecordTransport')
	return { ...actual, sendShellRecordCommand: jest.fn() }
})

const mockSend = sendShellRecordCommand as jest.MockedFunction<typeof sendShellRecordCommand>

const ADDR = '0x1563915e194D8CfBA1943570603F7606A3115508'
const ADDR_LC = ADDR.toLowerCase()
const KEY = '0x' + '2'.repeat(64)
const OTHER = '0x5CbDd86a2FA8Dc4bDdd8a8f69dBa48572EeC07FB'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' // public BIP-39 test vector (checksum valid)
// a G0 copy: the EOA private key is stripped, the mnemonic is kept (native no_key)
const g0Record = (extra: Record<string, unknown> = {}) => ({ rev: 4, profiles: [{ keyID: ADDR_LC }], mnemonicPhrase: MNEMONIC, ...extra })
const keyOnlyRecord = () => ({ rev: 2, profiles: [{ keyID: ADDR_LC, privateKeyArmor: KEY }] })

const ackOk = (result: Record<string, unknown>): ShellRecordAnswer => ({ kind: 'payload', payload: { type: 'ack', reqId: 1, ok: true, result } })

describe('shellRecordRead carries copyValidated and eoa on the result', () => {
	it('copyValidated true and eoa (lower case) are read; the record stays ok with rev', () => {
		const r = parseShellRecordRead({ type: 'ack', ok: true, result: { code: 'ok', record: g0Record(), copyValidated: true, eoa: ADDR } })
		expect(r.status).toBe('ok')
		if (r.status !== 'ok') return
		expect(r.copyValidated).toBe(true)
		expect(r.eoa).toBe(ADDR_LC)
		expect(r.rev).toBe(4)
	})

	it('a missing or non-boolean copyValidated is false (a string "true" does not count)', () => {
		const a = parseShellRecordRead({ type: 'ack', ok: true, result: { code: 'ok', record: g0Record(), eoa: ADDR } })
		const b = parseShellRecordRead({ type: 'ack', ok: true, result: { code: 'ok', record: g0Record(), copyValidated: 'true', eoa: ADDR } })
		expect(a.status === 'ok' && a.copyValidated).toBe(false)
		expect(b.status === 'ok' && b.copyValidated).toBe(false)
	})

	it('copyValidated is read from the result, not from the record', () => {
		const r = parseShellRecordRead({ type: 'ack', ok: true, result: { code: 'ok', record: g0Record({ copyValidated: true }) } })
		expect(r.status === 'ok' && r.copyValidated).toBe(false)
	})

	it('a G0 copy without the EOA private key is accepted when copyValidated is true (it is not a hold)', () => {
		const r = parseShellRecordRead({ type: 'ack', ok: true, result: { code: 'ok', record: g0Record(), copyValidated: true, eoa: ADDR } })
		expect(r.status).toBe('ok')
	})

	it('without copyValidated the same G0 copy is a hold (needs_native_recovery), as before', () => {
		const r = parseShellRecordRead({ type: 'ack', ok: true, result: { code: 'ok', record: g0Record() } })
		expect(r).toEqual({ status: 'error', reason: 'needs_native_recovery' })
	})

	it('a validated copy without a profiles list is an error (wallet_fields_missing)', () => {
		const r = parseShellRecordRead({ type: 'ack', ok: true, result: { code: 'ok', record: { rev: 1 }, copyValidated: true, eoa: ADDR } })
		expect(r).toEqual({ status: 'error', reason: 'wallet_fields_missing' })
	})
})

describe('validatedCopyAccount: the only route to /home on the native check (21.8 step 1)', () => {
	const base = () => ({ copyValidated: true, eoa: ADDR_LC, record: g0Record() as Record<string, unknown> })

	it('true when copyValidated, eoa equals keyID, and a mnemonic is in the record', () => {
		expect(validatedCopyAccount(base())).toBe(true)
	})

	it('rule B: recoveryWords alone is not enough; an invalid mnemonic (failed checksum) is not enough', () => {
		const r = base()
		r.record = { rev: 1, profiles: [{ keyID: ADDR_LC }], recoveryWords: 'a b c' }
		expect(validatedCopyAccount(r)).toBe(false)
		expect(validatedCopyAccount({ ...base(), record: g0Record({ mnemonicPhrase: 'a b c' }) })).toBe(false)
	})

	it('false when copyValidated is missing or not true', () => {
		expect(validatedCopyAccount({ ...base(), copyValidated: false })).toBe(false)
		expect(validatedCopyAccount({ ...base(), copyValidated: undefined })).toBe(false)
	})

	it('false when eoa differs from the keyID (another account)', () => {
		expect(validatedCopyAccount({ ...base(), eoa: OTHER.toLowerCase() })).toBe(false)
	})

	it('false when eoa is null', () => {
		expect(validatedCopyAccount({ ...base(), eoa: null })).toBe(false)
	})

	it('false when the record has no mnemonic field (a field on its own is not the marker)', () => {
		const r = base()
		r.record = { rev: 1, profiles: [{ keyID: ADDR_LC }] }
		expect(validatedCopyAccount(r)).toBe(false)
	})

	it('false when the mnemonic field is blank', () => {
		const r = base()
		r.record = { rev: 1, profiles: [{ keyID: ADDR_LC }], mnemonicPhrase: '   ' }
		expect(validatedCopyAccount(r)).toBe(false)
	})
})

describe('quarantine command (22.3)', () => {
	beforeEach(() => {
		resetShellRecordForTest()
		mockSend.mockReset()
	})

	it('the request is {type, reqId, keyID} and the key id is lower case', async () => {
		mockSend.mockResolvedValueOnce(ackOk({ code: 'ok', quarantined: true, auditRef: 'a-1' }))
		const out = await quarantineKeyOnlyShellRecord(ADDR)
		expect(out).toEqual({ status: 'quarantined', auditRef: 'a-1' })
		const cmd = mockSend.mock.calls[0][0] as Record<string, unknown>
		expect(Object.keys(cmd).sort()).toEqual(['keyID', 'reqId', 'type'])
		expect(cmd.type).toBe(SHELL_RECORD_QUARANTINE_KEY_ONLY)
		expect(cmd.keyID).toBe(ADDR_LC)
	})

	it('a malformed key id is refused without sending anything', async () => {
		const out = await quarantineKeyOnlyShellRecord('0x12')
		expect(out).toEqual({ status: 'refused', reason: 'bad_key_id' })
		expect(mockSend).not.toHaveBeenCalled()
	})

	it('ok without quarantined true or without auditRef is unknown (fail closed)', () => {
		expect(parseQuarantineAnswer(ackOk({ code: 'ok', quarantined: false, auditRef: 'x' })).status).toBe('unknown')
		expect(parseQuarantineAnswer(ackOk({ code: 'ok', quarantined: true })).status).toBe('unknown')
	})

	it('refused carries the reason; storage_locked, audit_failed etc. are refusals or unknown by code', () => {
		expect(parseQuarantineAnswer(ackOk({ code: 'refused', reason: 'valid_phrase_present' }))).toEqual({ status: 'refused', reason: 'valid_phrase_present' })
		expect(parseQuarantineAnswer(ackOk({ code: 'unknown', reason: 'audit_failed' }))).toEqual({ status: 'unknown', reason: 'audit_failed' })
	})

	it('unknown_command, not_supported and timeouts are unknown (the caller stops and shows retry)', () => {
		expect(parseQuarantineAnswer({ kind: 'not_supported' }).status).toBe('unknown')
		expect(parseQuarantineAnswer({ kind: 'timeout' }).status).toBe('unknown')
		expect(parseQuarantineAnswer({ kind: 'payload', payload: { type: 'ack', ok: false, error: 'unknown_command' } })).toEqual({
			status: 'unknown',
			reason: 'unknown_command',
		})
	})
})

describe('prepareShellFreshWrite (22.4): a fresh account over a key-only copy isolates it first', () => {
	beforeEach(() => {
		resetShellRecordForTest()
		mockSend.mockReset()
	})

	const isKeyOnly = (rec: Record<string, unknown>) => !(typeof rec.mnemonicPhrase === 'string' && rec.mnemonicPhrase.trim())

	it('absent store: nothing is isolated and the write is not blocked', async () => {
		mockSend.mockResolvedValueOnce(ackOk({ code: 'absent' }))
		expect(await prepareShellFreshWrite(isKeyOnly, OTHER)).toEqual({ isolated: false })
		expect(mockSend).toHaveBeenCalledTimes(1)
	})

	it('a record with a mnemonic is not key-only: no isolation command is sent', async () => {
		mockSend.mockResolvedValueOnce(ackOk({ code: 'ok', record: g0Record(), copyValidated: true, eoa: ADDR_LC }))
		expect(await prepareShellFreshWrite(isKeyOnly, OTHER)).toEqual({ isolated: false })
		expect(mockSend).toHaveBeenCalledTimes(1)
	})

	it('a restore of the same account (the copy holds the written keyID) is not isolated', async () => {
		mockSend.mockResolvedValueOnce(ackOk({ code: 'ok', record: keyOnlyRecord() }))
		expect(await prepareShellFreshWrite(isKeyOnly, ADDR)).toEqual({ isolated: false })
		expect(mockSend).toHaveBeenCalledTimes(1)
	})

	it('a key-only copy is isolated only after the command answers ok (quarantined, audited)', async () => {
		mockSend.mockResolvedValueOnce(ackOk({ code: 'ok', record: keyOnlyRecord() }))
		mockSend.mockResolvedValueOnce(ackOk({ code: 'ok', quarantined: true, auditRef: 'a-2' }))
		expect(await prepareShellFreshWrite(isKeyOnly, OTHER)).toEqual({ isolated: true })
		expect(mockSend).toHaveBeenCalledTimes(2)
		expect((mockSend.mock.calls[1][0] as Record<string, unknown>).type).toBe(SHELL_RECORD_QUARANTINE_KEY_ONLY)
		// the isolation is a move (quarantine), never a delete. The page sends no remove or delete request. Whether the native
		// bytes are still present is checked on the native side (outside this suite).
		const types = mockSend.mock.calls.map((c) => String((c[0] as Record<string, unknown>).type))
		expect(types.some((t) => /remove|delete|erase|wipe/i.test(t))).toBe(false)
	})

	it('a refused isolation throws and nothing else is sent (the old copy stays, no full write)', async () => {
		mockSend.mockResolvedValueOnce(ackOk({ code: 'ok', record: keyOnlyRecord() }))
		mockSend.mockResolvedValueOnce(ackOk({ code: 'refused', reason: 'key_id_mismatch' }))
		await expect(prepareShellFreshWrite(isKeyOnly, OTHER)).rejects.toThrow('key_only_not_isolated_refused')
		expect(mockSend).toHaveBeenCalledTimes(2)
	})

	it('an unknown isolation (not_supported on an older native) throws: never a silent write', async () => {
		mockSend.mockResolvedValueOnce(ackOk({ code: 'ok', record: keyOnlyRecord() }))
		mockSend.mockResolvedValueOnce({ kind: 'not_supported' })
		await expect(prepareShellFreshWrite(isKeyOnly, OTHER)).rejects.toThrow('key_only_not_isolated_unknown')
	})

	it('a read that does not answer ok or absent throws before anything is isolated', async () => {
		mockSend.mockResolvedValueOnce(ackOk({ code: 'error', sub: 'storage_locked' }))
		await expect(prepareShellFreshWrite(isKeyOnly, OTHER)).rejects.toThrow('fresh_write_read_storage_locked')
		expect(mockSend).toHaveBeenCalledTimes(1)
	})
})

// The page routing and the persist guard live in beamio.ts (source checks, as the other static pins of the shell do).
describe('beamio.ts wiring (static): copyValidated first, fresh write behind the isolation', () => {
	const src = require('fs').readFileSync(require('path').join(__dirname, 'beamio.ts'), 'utf8') as string
	// the native read is the helper shellNativeFirstRead (read first); the caller reads the old store only after it
	const readFn = src.slice(src.indexOf('const shellNativeFirstRead = async'), src.indexOf('const readStorageWithStatus = async'))
	const persistFn = src.slice(src.indexOf('const persistInitRecord = async'), src.indexOf('const walletStores = ('))

	it('the shell read takes validatedCopyAccount before any shellRecordAsWalletRecord, and enters on the native check', () => {
		const validatedAt = readFn.indexOf('validatedCopyAccount(read)')
		const plainAt = readFn.indexOf('rec = shellRecordAsWalletRecord(read)')
		expect(validatedAt).toBeGreaterThan(0)
		expect(plainAt).toBeGreaterThan(validatedAt)
		// the validated branch is entered before the no_key handling of the plain copy
		const enterAt = readFn.indexOf("if (validatedEoa !== null && rec)")
		const noKeyAt = readFn.indexOf("if (native.kind === 'refused' && native.code === NO_KEY_ERROR) {")
		expect(enterAt).toBeGreaterThan(0)
		expect(noKeyAt).toBeGreaterThan(enterAt)
	})

	it('the validated entry is refused when the native account is another account (eoa_mismatch), and held on a native read failure', () => {
		const enterAt = readFn.indexOf('if (validatedEoa !== null && rec)')
		const branch = readFn.slice(enterAt, readFn.indexOf("if (!rec) return { kind: 'empty' }", enterAt))
		expect(branch).toMatch(/native\.kind === 'address' && native\.eoa !== validatedEoa\) return \{ kind: 'result', result: \{ status: 'unavailable', reason: 'eoa_mismatch' \} \}/)
		expect(branch).toMatch(/native_retry/)
	})

	it('the page does not derive a key on the validated path', () => {
		const enterAt = readFn.indexOf("if (validatedEoa !== null && rec)")
		const branch = readFn.slice(enterAt, readFn.indexOf("if (!rec) return { kind: 'empty' }"))
		expect(branch).not.toMatch(/createKeyHDWallets|Wallet\.fromPhrase|ensureProfilePrivateKeyArmorFromMnemonic/)
	})

	it('a full write of a shell record is preceded by the fresh-write guard (no write before the isolation)', () => {
		const guardAt = persistFn.indexOf('prepareShellFreshWrite(')
		const writeAt = persistFn.indexOf('await writeInitObject(record)')
		expect(guardAt).toBeGreaterThan(0)
		expect(writeAt).toBeGreaterThan(guardAt)
	})
})

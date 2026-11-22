/**
 * @jest-environment node
 */
/**
 * (review d5db240, must-fix 2): the start-up entry cases with the native answers replaced (walletEoaAddress and the pre-read
 * answer are stubs, as the review allows). Each case checks the page evidence, the sync it leads to (the number of pwaWalletSync sends and
 * the EOA sent), and the hold/adopt decision. SYNTHETIC values only. The phrase is the public BIP-39 test vector.
 */
import { copyPageEvidence, decidePrereadEntry, isNativeCopyValidated } from './copyValidatedEntry'
import type { CheckStorageResult } from './beamio'
import type { WalletEoaAddressAnswer } from './walletEoaAddress'
import { createShellMnemonicSync, pageSyncPayload, SHELL_MNEMONIC_SYNC_COMMAND, type ShellSyncAnswer } from './shellMnemonicSync'

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const COPY_EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const OTHER_EOA = '0x' + 'ab'.repeat(20)

/** A page copy as the start read returns it when the shell validated it natively (beamio.ts sets the flag on that branch only). */
const validatedCopy = (keyID: string): CheckStorageResult =>
	({
		status: 'loaded',
		copyValidated: true,
		data: { profiles: [{ keyID }], mnemonicPhrase: PHRASE } as never,
	}) as CheckStorageResult

const address = (eoa: string): WalletEoaAddressAnswer => ({ kind: 'address', eoa })
const noKey: WalletEoaAddressAnswer = { kind: 'refused', code: 'no_key' }
const notReady: WalletEoaAddressAnswer = { kind: 'refused', code: 'not_ready' }

/** The sync the gate starts for a valid page evidence: the production payload rule, then the sync with a fake bridge. */
function syncFor(evidence: ReturnType<typeof copyPageEvidence>) {
	const payload = evidence ? pageSyncPayload(evidence.kind === 'valid' ? evidence : { kind: 'unknown' }) : null
	const send = jest.fn(async (_c: string, _t: number, _m: string, _e: string): Promise<ShellSyncAnswer> => 'ok')
	const sync = createShellMnemonicSync({ send, retryDelaysMs: [], wait: async () => undefined, log: () => undefined, bridgeAvailable: () => true })
	return { payload, send, run: () => (payload ? sync.sync(payload.phrase, payload.eoa) : Promise.resolve(null)) }
}

describe('start-up entry case 1: validated copy and native address for the same account', () => {
	it('enters on the native EOA; the sync is sent once with that EOA; nothing is derived from the page', async () => {
		const evidence = copyPageEvidence(validatedCopy(COPY_EOA), address(COPY_EOA))
		expect(evidence).toEqual({ kind: 'valid', eoa: COPY_EOA, phrase: PHRASE, nativeValidated: true })
		const s = syncFor(evidence)
		await s.run()
		expect(s.send).toHaveBeenCalledTimes(1)
		expect((s.send.mock.calls[0] as unknown[])[0]).toBe(SHELL_MNEMONIC_SYNC_COMMAND)
		expect((s.send.mock.calls[0] as unknown[])[3]).toBe(COPY_EOA)
	})
})

describe('case A: a native-validated copy whose EOA contradicts the native walletEoaAddress (internal contradiction)', () => {
	it('A: copy EOA B, native address A → unknown: data kept, nothing sent, nothing written (retryable)', async () => {
		const evidence = copyPageEvidence(validatedCopy(COPY_EOA), address(OTHER_EOA))
		expect(evidence).toEqual({ kind: 'unknown' })
		const s = syncFor(evidence)
		expect(s.payload).toBeNull()
		expect(await s.run()).toBeNull()
		expect(s.send).not.toHaveBeenCalled()
	})
})

describe('start-up entry case 3: validated copy and native no_key (the expected answer, beamio.ts ~1697)', () => {
	it('enters (never waits as unknown) on the copy EOA, without a page hold; the sync is sent once', async () => {
		const evidence = copyPageEvidence(validatedCopy(COPY_EOA), noKey)
		expect(evidence).toEqual({ kind: 'valid', eoa: COPY_EOA, phrase: PHRASE, nativeValidated: true })
		const s = syncFor(evidence)
		await s.run()
		expect(s.send).toHaveBeenCalledTimes(1)
	})

	it('a native read that is not no_key (not ready) stays unknown: the data is kept, nothing is sent', () => {
		expect(copyPageEvidence(validatedCopy(COPY_EOA), notReady)).toEqual({ kind: 'unknown' })
	})
})

describe('start-up entry case 4: no validated copy, pre-read valid (the adopt path is unchanged)', () => {
	it('an unvalidated copy gives no evidence here; the pre-read valid path adopts the phrase and never takes the native shortcut', async () => {
		const plain = { status: 'loaded', data: { profiles: [{ keyID: COPY_EOA }], mnemonicPhrase: PHRASE } } as unknown as CheckStorageResult
		expect(isNativeCopyValidated(plain, '')).toBe(false)
		expect(copyPageEvidence(plain, address(COPY_EOA))).toBeNull()
		const native = jest.fn()
		const adopt = jest.fn(async () => undefined)
		expect(await decidePrereadEntry({ status: 'empty' }, COPY_EOA, native, adopt)).toBe('adopted')
		expect(adopt).toHaveBeenCalledTimes(1)
		expect(native).not.toHaveBeenCalled()
	})
})

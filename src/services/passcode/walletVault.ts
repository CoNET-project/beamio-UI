/**
 * PWA wallet storage. Pure orchestration with injected stores; production
 * wiring is in beamio.ts (init document, `meta` document, IndexedDB device key).
 *
 * Layout: the secret fields are replaced in place by wrap records (walletWrap.ts). Passcode mode uses PBKDF2 (600000);
 * device mode uses the non-extractable device key. Failed passcode tries are counted in `meta` with the spec backoff
 * table; data is never erased on failure. Nothing in this module logs a value.
 */
import { ethers } from 'ethers'
import { checkPasscodePolicy, backoffSecondsAfter, type PasscodeReason } from './passcodeRules'
import {
	type DeviceKeyStore,
	type WrapRecord,
	VaultError,
	b64dec,
	getDeviceKey,
	isWrapRecord,
	newSalt,
	passcodeWrapKey,
	unwrapField,
	wrapField,
} from './walletWrap'

export type Loose = Record<string, any>

export interface WalletMeta {
	/** marker */
	walletWrapState?: 'wrapped'
	/** consecutive wrong passcodes; success resets */
	failures: number
	/** epoch ms before which passcode tries are refused (0 = none) */
	nextAt: number
}

export interface WalletStores {
	readInit(): Promise<Loose | null>
	/** A read before a save that does not move the write basis (shell). Optional: the browser reads the same way. */
	probeInit?(): Promise<Loose | null>
	/** Durable write of the init object; resolves after the store read-back accepted it. */
	writeInit(data: Loose): Promise<void>
	readMeta(): Promise<WalletMeta>
	writeMeta(m: WalletMeta): Promise<void>
	deviceKeys: DeviceKeyStore
}

// ---------------------------------------------------------------------------
// Session (in memory only)
// ---------------------------------------------------------------------------

interface PasscodeSession {
	key: CryptoKey
	salt: Uint8Array
	acct: string
}

const session: { device: CryptoKey | null; pc: PasscodeSession | null } = { device: null, pc: null }

export function lockWalletSession(): void {
	session.pc = null
}

export function resetWalletSession(): void {
	session.pc = null
	session.device = null
}

export function passcodeSessionUnlocked(acct: string): boolean {
	return !!session.pc && session.pc.acct === acct.toLowerCase()
}

async function deviceKey(stores: WalletStores, create: boolean): Promise<CryptoKey> {
	if (session.device) return session.device
	session.device = await getDeviceKey(stores.deviceKeys, create)
	return session.device
}

// ---------------------------------------------------------------------------
// Secret slots: one per secret value, with its AAD field name and account
// ---------------------------------------------------------------------------

interface Slot {
	field: string
	eoa: string
	get(d: Loose): unknown
	set(d: Loose, v: unknown): void
	/** sibling key used by the coexistence step */
	setSibling(d: Loose, v: unknown): void
	getSibling(d: Loose): unknown
}

const flatProfiles = (p: unknown): Loose[] => (Array.isArray(p) ? ((p as unknown[]).flat() as Loose[]) : [])

const isSecretString = (v: unknown): v is string => typeof v === 'string' && v.length > 0

function slotsOf(data: Loose): Slot[] {
	const profiles = flatProfiles(data.profiles)
	const primary = String(profiles[0]?.keyID ?? '').toLowerCase()
	const slots: Slot[] = []
	for (const field of ['mnemonicPhrase', 'recoveryWords'] as const) {
		slots.push({
			field,
			eoa: primary,
			get: (d) => d[field],
			set: (d, v) => {
				d[field] = v
			},
			setSibling: (d, v) => {
				d[`${field}Wrap`] = v
			},
			getSibling: (d) => d[`${field}Wrap`],
		})
	}
	profiles.forEach((p, idx) => {
		const eoa = String(p.keyID ?? '').toLowerCase()
		slots.push({
			field: 'privateKeyArmor',
			eoa,
			get: (d) => (d.profiles ? flatProfiles(d.profiles)[idx]?.privateKeyArmor : undefined),
			set: (d, v) => {
				flatProfiles(d.profiles)[idx].privateKeyArmor = v
			},
			setSibling: (d, v) => {
				flatProfiles(d.profiles)[idx].privateKeyArmorWrap = v
			},
			getSibling: (d) => flatProfiles(d.profiles)[idx]?.privateKeyArmorWrap,
		})
		// Shell build: the page holds no PGP private key, so this slot is not built (compiled out).
		if (process.env.REACT_APP_SHELL_BUILD !== 'true') slots.push({
			field: 'pgpPrivateKeyArmored',
			eoa,
			get: (d) => flatProfiles(d.profiles)[idx]?.pgpKey?.privateKeyArmor,
			set: (d, v) => {
				const q = flatProfiles(d.profiles)[idx]
				q.pgpKey = { ...(q.pgpKey ?? {}), privateKeyArmor: v }
			},
			setSibling: (d, v) => {
				const q = flatProfiles(d.profiles)[idx]
				q.pgpKey = { ...(q.pgpKey ?? {}), privateKeyArmorWrap: v }
			},
			getSibling: (d) => flatProfiles(d.profiles)[idx]?.pgpKey?.privateKeyArmorWrap,
		})
	})
	return slots
}

/** Copy of the data whose profile objects can be changed without touching the caller's objects. */
function copyData(data: Loose): Loose {
	const profiles = flatProfiles(data.profiles).map((p) => ({ ...p, pgpKey: p.pgpKey ? { ...p.pgpKey } : p.pgpKey }))
	return { ...data, profiles }
}

const primaryAcct = (data: Loose): string => String(flatProfiles(data.profiles)[0]?.keyID ?? '').toLowerCase()

export function hasPlainSecrets(data: Loose | null | undefined): boolean {
	if (!data) return false
	return slotsOf(data).some((s) => isSecretString(s.get(data)))
}

export function hasWrappedSecrets(data: Loose | null | undefined): boolean {
	if (!data) return false
	return slotsOf(data).some((s) => isWrapRecord(s.get(data)))
}

function passcodeRecordsIn(data: Loose): boolean {
	return slotsOf(data).some((s) => {
		const v = s.get(data)
		return isWrapRecord(v) && v.mode === 'passcode'
	})
}

/** Replaces every non-empty plain secret with a wrap made by `wrap`. Input is not mutated. */
async function wrapInPlace(data: Loose, wrap: (slot: Slot, value: string) => Promise<WrapRecord>): Promise<Loose> {
	const out = copyData(data)
	for (const slot of slotsOf(out)) {
		const v = slot.get(out)
		if (!isSecretString(v)) continue
		if (!slot.eoa) throw new VaultError('acct_missing')
		slot.set(out, await wrap(slot, v))
	}
	return out
}

/** Decrypts every wrap record in place. A plain value is kept as it is. */
async function unwrapInPlace(data: Loose, unwrap: (slot: Slot, rec: WrapRecord) => Promise<string>): Promise<Loose> {
	const out = copyData(data)
	for (const slot of slotsOf(out)) {
		const v = slot.get(out)
		if (isWrapRecord(v)) slot.set(out, await unwrap(slot, v))
	}
	return out
}

/** Copy without the sibling wraps (a previous, interrupted run may have left them). */
function removeSiblings(data: Loose): Loose {
	const out = copyData(data)
	for (const slot of slotsOf(out)) slot.setSibling(out, undefined)
	return out
}

function deviceWrapper(key: CryptoKey) {
	return (slot: Slot, value: string) => wrapField(key, value, slot.field, slot.eoa, 'device')
}

function passcodeWrapper(key: CryptoKey, salt: Uint8Array) {
	return (slot: Slot, value: string) => wrapField(key, value, slot.field, slot.eoa, 'passcode', salt)
}

// ---------------------------------------------------------------------------
// Startup read
// ---------------------------------------------------------------------------

export type StartupResult =
	| { status: 'loaded'; data: Loose }
	| { status: 'locked' }
	| { status: 'error'; reason: string }

/** Reads the wallet for start-up. Passcode records report locked until unlockWalletPasscode succeeds. */
export async function openWalletForStartup(stores: WalletStores, data: Loose): Promise<StartupResult> {
	try {
		if (hasPlainSecrets(data)) return { status: 'loaded', data }
		if (hasWrappedSecrets(data)) {
			const acct = primaryAcct(data)
			if (passcodeRecordsIn(data) && !passcodeSessionUnlocked(acct)) return { status: 'locked' }
			let device: CryptoKey | null = null
			const plain = await unwrapInPlace(data, async (slot, rec) => {
				if (rec.mode === 'passcode') return unwrapField(session.pc!.key, rec, slot.field)
				device = device ?? (await deviceKey(stores, false))
				return unwrapField(device, rec, slot.field)
			})
			return { status: 'loaded', data: plain }
		}
		return { status: 'loaded', data }
	} catch (ex) {
		return { status: 'error', reason: (ex as VaultError)?.code ?? 'open_failed' }
	}
}

/** Read-back check: the stored blob, opened with the current keys, equals the plain values. */
/** A read that does not feed the page copy (verification, passcode state, migration checks): a probe when the store has one. */
function probeRead(stores: WalletStores): Promise<Loose | null> {
	return stores.probeInit ? stores.probeInit() : stores.readInit()
}

async function verifyWrapped(stores: WalletStores, plain: Loose, mode: 'device' | 'passcode', passKey?: CryptoKey): Promise<void> {
	const back = await probeRead(stores)
	if (!back) throw new VaultError('readback_missing')
	const expected = slotsOf(plain)
	const got = slotsOf(back)
	for (let i = 0; i < expected.length; i++) {
		const want = expected[i].get(plain)
		if (!isSecretString(want)) continue
		const rec = got[i].get(back)
		if (!isWrapRecord(rec) || rec.mode !== mode) throw new VaultError('readback_mismatch')
		const key = mode === 'device' ? await deviceKey(stores, false) : passKey!
		if ((await unwrapField(key, rec, expected[i].field)) !== want) throw new VaultError('readback_mismatch')
	}
}

// ---------------------------------------------------------------------------
// plaintext → wrapped (device mode)
// ---------------------------------------------------------------------------

export type PlainMigration = 'migrated' | 'kept' | 'none'

export async function migratePlainWallet(stores: WalletStores): Promise<PlainMigration> {
	const original = await probeRead(stores)
	if (!original || !hasPlainSecrets(original)) return 'none'
	const restore = async () => {
		try {
			await writeInitWithKeep(stores, original)
		} catch {
			/* the original text is still the last successful write */
		}
	}
	let key: CryptoKey
	try {
		key = await deviceKey(stores, true)
	} catch {
		return 'kept'
	}
	// wraps written next to the plaintext (coexistence). Plaintext is kept.
	try {
		const side = copyData(original)
		for (const slot of slotsOf(side)) {
			const v = slot.get(side)
			if (!isSecretString(v)) continue
			slot.setSibling(side, await wrapField(key, v, slot.field, slot.eoa, 'device'))
		}
		await writeInitWithKeep(stores, side)
	} catch {
		await restore()
		return 'kept'
	}
	// read-back check. Decrypted keys equal the plaintext, the EOA key derives the account, and the signature matches.
	try {
		const back = await probeRead(stores)
		if (!back) throw new VaultError('readback_missing')
		for (const slot of slotsOf(original)) {
			const want = slot.get(original)
			if (!isSecretString(want)) continue
			const rec = slot.getSibling(back)
			if (!isWrapRecord(rec)) throw new VaultError('readback_missing')
			const got = await unwrapField(key, rec, slot.field)
			if (got !== want) throw new VaultError('readback_mismatch')
			if (slot.field === 'privateKeyArmor') {
				const pk = (v: string) => (v.startsWith('0x') ? v : `0x${v}`)
				if (ethers.computeAddress(pk(got)).toLowerCase() !== slot.eoa) throw new VaultError('address_mismatch')
				const msg = 'beamio wallet wrap check v1'
				const sigGot = await new ethers.Wallet(pk(got)).signMessage(msg)
				const sigWant = await new ethers.Wallet(pk(want)).signMessage(msg)
				if (sigGot !== sigWant) throw new VaultError('signature_mismatch')
			}
		}
	} catch {
		await restore()
		return 'kept'
	}
	// plaintext fields replaced in place; no plaintext and no sibling left in the stored blob.
	try {
		const final = await wrapInPlace(removeSiblings(original), deviceWrapper(key))
		await writeInitWithKeep(stores, final)
		const back = await probeRead(stores)
		if (!back || hasPlainSecrets(back) || JSON.stringify(back).includes('"privateKeyArmorWrap"')) {
			throw new VaultError('final_check_failed')
		}
	} catch {
		// Both copies exist and the wraps are verified: the next start redoes (idempotent).
		return 'kept'
	}
	//
	await stores.writeMeta({ ...(await stores.readMeta()), walletWrapState: 'wrapped' })
	return 'migrated'
}

// ---------------------------------------------------------------------------
// Passcode lifecycle
// ---------------------------------------------------------------------------

export type UnlockResult =
	| { ok: true; data: Loose }
	| { ok: false; reason: 'format' | 'no_passcode' | 'backoff' | 'wrong_passcode' | 'error'; retryAfterMs?: number; attempts?: number }

const PASSCODE_FORMAT = /^[0-9]{8,12}$/

async function failWrong(stores: WalletStores, now: number): Promise<UnlockResult> {
	const meta = await stores.readMeta()
	const failures = meta.failures + 1
	const waitSec = backoffSecondsAfter(failures)
	await stores.writeMeta({ ...meta, failures, nextAt: waitSec > 0 ? now + waitSec * 1000 : 0 })
	return { ok: false, reason: 'wrong_passcode', retryAfterMs: waitSec * 1000, attempts: failures }
}

async function clearFailures(stores: WalletStores): Promise<void> {
	const meta = await stores.readMeta()
	if (meta.failures !== 0 || meta.nextAt !== 0) await stores.writeMeta({ ...meta, failures: 0, nextAt: 0 })
}

/** Checks the passcode. Failed tries are counted and waited on; nothing is erased. On success the session holds the key. */
export async function unlockWalletPasscode(stores: WalletStores, passcode: string, now = Date.now()): Promise<UnlockResult> {
	if (!PASSCODE_FORMAT.test(passcode)) return { ok: false, reason: 'format' }
	const meta = await stores.readMeta()
	if (now < meta.nextAt) return { ok: false, reason: 'backoff', retryAfterMs: meta.nextAt - now }
	//the unlock read is a probe. Its result is not the page copy (unlockWalletVaultWithPasscode returns ok only).
	const init = await probeRead(stores)
	if (init && passcodeRecordsIn(init)) {
		const acct = primaryAcct(init)
		const first = slotsOf(init).map((s) => s.get(init)).find((v): v is WrapRecord => isWrapRecord(v) && v.mode === 'passcode')!
		const key = await passcodeWrapKey(passcode, b64dec(first.salt as string))
		let plain: Loose
		try {
			plain = await unwrapInPlace(init, async (slot, rec) => {
				if (rec.mode === 'passcode') return unwrapField(key, rec, slot.field)
				return unwrapField(await deviceKey(stores, false), rec, slot.field)
			})
		} catch {
			return failWrong(stores, now)
		}
		session.pc = { key, salt: b64dec(first.salt as string), acct }
		await clearFailures(stores)
		return { ok: true, data: plain }
	}
	return { ok: false, reason: 'no_passcode' }
}

/** Writes the passcode-mode blob with a new salt, verifies it, and makes the key the session key. */
async function setPasscodeInternal(stores: WalletStores, passcode: string, plain: Loose): Promise<'error' | null> {
	const acct = primaryAcct(plain)
	const salt = newSalt()
	const key = await passcodeWrapKey(passcode, salt)
	const wrapped = await wrapInPlace(plain, passcodeWrapper(key, salt))
	await writeInitWithKeep(stores, wrapped)
	await verifyWrapped(stores, plain, 'passcode', key)
	session.pc = { key, salt, acct }
	return null
}

export type SetResult =
	| { ok: true }
	| { ok: false; reason: 'weak'; problem: PasscodeReason }
	| { ok: false; reason: 'locked' | 'error' | 'format' | 'no_passcode' | 'backoff' | 'wrong_passcode'; retryAfterMs?: number }

/** Turns the passcode layer on (or replaces it when already on and unlocked). Policy is checked first. */
export async function setWalletPasscode(stores: WalletStores, passcode: string, plain: Loose): Promise<SetResult> {
	const check = checkPasscodePolicy(passcode)
	if (!check.ok) return { ok: false, reason: 'weak', problem: check.reason }
	if (!hasPlainSecrets(plain)) return { ok: false, reason: 'error' }
	const acct = primaryAcct(plain)
	const existing = await probeRead(stores)
	if (existing && passcodeRecordsIn(existing) && !passcodeSessionUnlocked(acct)) return { ok: false, reason: 'locked' }
	try {
		await setPasscodeInternal(stores, passcode, plain)
		await clearFailures(stores)
		return { ok: true }
	} catch {
		return { ok: false, reason: 'error' }
	}
}

/** Change: the old passcode is checked first (counted), then the blob is re-wrapped under the new one. */
export async function changeWalletPasscode(stores: WalletStores, oldPasscode: string, newPasscode: string, now = Date.now()): Promise<SetResult | UnlockResult> {
	const unlocked = await unlockWalletPasscode(stores, oldPasscode, now)
	if (!unlocked.ok) return unlocked
	return setWalletPasscode(stores, newPasscode, unlocked.data)
}

/** Turn off: the passcode is checked, then the blob goes back to device mode and is verified. */
export async function disableWalletPasscode(stores: WalletStores, passcode: string, now = Date.now()): Promise<{ ok: true } | UnlockResult | { ok: false; reason: 'error' }> {
	const unlocked = await unlockWalletPasscode(stores, passcode, now)
	if (!unlocked.ok) return unlocked
	try {
		const wrapped = await wrapInPlace(unlocked.data, deviceWrapper(await deviceKey(stores, true)))
		await writeInitWithKeep(stores, wrapped)
		await verifyWrapped(stores, unlocked.data, 'device')
	} catch {
		return { ok: false, reason: 'error' }
	}
	lockWalletSession()
	await clearFailures(stores)
	return { ok: true }
}

/** True when the stored wallet is passcode-protected (from the wrap records). */
export async function passcodeEnabled(stores: WalletStores): Promise<boolean> {
	const init = await probeRead(stores)
	return !!init && passcodeRecordsIn(init)
}

// ---------------------------------------------------------------------------
// Persist (write path)
// ---------------------------------------------------------------------------

/**
 * Data to write for the current in-memory wallet. Passcode records need the session key; device records need the device
 * key (never created over existing records). A slot that is empty in memory keeps its stored wrap (e.g. after sign-out).
 */
export async function wrapForPersist(stores: WalletStores, plain: Loose): Promise<Loose> {
	const acct = primaryAcct(plain)
	const existing = (stores.probeInit ? await stores.probeInit() : await stores.readInit()) ?? {}
	const existingRecs = slotsOf(existing).map((s) => s.get(existing)).filter(isWrapRecord)
	const pcExisting = existingRecs.some((r) => r.mode === 'passcode')
	const deviceExisting = existingRecs.some((r) => r.mode === 'device')
	if (pcExisting && !passcodeSessionUnlocked(acct)) throw new VaultError('vault_locked')
	let out: Loose
	if (passcodeSessionUnlocked(acct)) {
		out = await wrapInPlace(plain, passcodeWrapper(session.pc!.key, session.pc!.salt))
	} else {
		out = await wrapInPlace(plain, deviceWrapper(await deviceKey(stores, !deviceExisting)))
	}
	const merged = keepStoredSecretsForEmptySlots(out, existing)
	assertStoredSecretsKept(existing, merged)
	return merged
}

/**
 * The one write entry of the wallet store (0.53.39, independent review 4fd31f0a, item 2). Every write of the init object goes through here:
 * a slot that is empty in the record keeps the stored value (keepStoredSecretsForEmptySlots), and a write that would lose a stored secret
 * is refused before anything is written (the data is kept; the caller gets an error).
 */
export async function writeInitWithKeep(stores: WalletStores, record: Loose): Promise<void> {
	const before = ((stores.probeInit ? await stores.probeInit() : await stores.readInit()) ?? {}) as Loose
	const merged = keepStoredSecretsForEmptySlots(record, before)
	assertStoredSecretsKept(before, merged)
	await stores.writeInit(merged)
}

/**
 * The refusal (0.53.39, independent review 4fd31f0a, item 1). Every stored secret (a key or a mnemonic, wrapped or plain) must be kept by the
 * record about to be written, under its own identity (field and lower-case keyID). The write is refused, before anything is written, when:
 * - the stored record holds two secrets with the same identity (ambiguous: which one to keep is not known);
 * - the record about to be written has no single slot with that identity, or that slot is empty (the stored secret would be lost).
 * A missing keyID is an identity too (the empty string), so an account without a keyID is never guessed.
 */
export function assertStoredSecretsKept(before: Loose, merged: Loose): void {
	const isSecret = (v: unknown) => isWrapRecord(v) || isSecretString(v)
	const idOf = (s: Slot) => `${s.field}|${s.eoa}`
	const beforeSlots = slotsOf(before)
	const secretCount = new Map<string, number>()
	for (const s of beforeSlots) {
		if (!isSecret(s.get(before))) continue
		secretCount.set(idOf(s), (secretCount.get(idOf(s)) ?? 0) + 1)
	}
	const mergedSlots = slotsOf(merged)
	for (const s of beforeSlots) {
		if (!isSecret(s.get(before))) continue
		if ((secretCount.get(idOf(s)) ?? 0) > 1) throw new VaultError('secret_identity_ambiguous')
		const matches = mergedSlots.filter((m) => idOf(m) === idOf(s))
		if (matches.length !== 1 || !isSecret(matches[0].get(merged))) throw new VaultError('secret_would_be_lost')
	}
}

/**
 * 0.53.39 (independent review of 5dbad42): a slot that is empty in memory keeps the value already stored, whether that stored value is a
 * wrap record or a plain non-empty string (an old plaintext key). Before, only a wrap record was kept, so an old plaintext key was dropped
 * by a write made while the in-memory slot was empty. Pure: the caller passes the wrapped record and the stored record.
 */
export function keepStoredSecretsForEmptySlots(out: Loose, existing: Loose): Loose {
	// Slots are paired by their identity (the field and the lower-case keyID), never by array position: an account list in a different
	// order, or with a different number of accounts, must never move one account's key onto another account.
	const slotKey = (s: Slot): string => `${s.field}|${s.eoa}`
	const storedByKey = new Map<string, Slot>()
	for (const e of slotsOf(existing)) if (e.eoa) storedByKey.set(slotKey(e), e)
	for (const s of slotsOf(out)) {
		// a slot that holds a value now (a plain secret, or the wrap just made for it) is never replaced by the stored value
		const current = s.get(out)
		if (isWrapRecord(current) || isSecretString(current)) continue
		if (!s.eoa) continue
		const stored = storedByKey.get(slotKey(s))
		const kept = stored?.get(existing)
		if (isWrapRecord(kept) || isSecretString(kept)) s.set(out, kept)
	}
	return out
}

/**
 * The record as written to the store (write layer only). In a shell the stored PGP secret fields are kept on disk; the
 * copy is independent of the page state, so the page never holds the PGP key .
 */
export async function wrapForDisk(stores: WalletStores, plain: Loose): Promise<Loose> {
	// Plan N: in a shell, wrapForPersist reads the stored record through the bridge. The bridge answer is the native
	// copy without PGP private fields (sanitized on the native side), so no PGP bytes enter the page. The W-class fields are
	// withheld on that read the shell fails closed there (readInit throws), never treating them as absent.
	return wrapForPersist(stores, plain)
}

/** Plain data for a read-back check: decrypts the stored blob if the session allows it. */
export async function readPlainForVerify(stores: WalletStores): Promise<Loose | null> {
	const init = await probeRead(stores)
	if (!init) return null
	const res = await openWalletForStartup(stores, init)
	return res.status === 'loaded' ? res.data : null
}

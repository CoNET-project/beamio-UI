/**
 * PWA wallet storage. Pure orchestration with injected stores; production
 * wiring is in beamio.ts (init document, `meta` document, IndexedDB device key).
 *
 * Layout (unit f3, 2026-11-22): the secret fields are replaced in place by passcode wrap records (walletWrap.ts, Argon2id, v=3)
 * when a passcode is on; otherwise they stay plain (no-passcode state). Device-key mode and PBKDF2 are removed; records of those
 * formats are refused (verify_failed) and kept byte-for-byte. Failed passcode tries are counted in `meta` with passcodeBackoff
 * (3 wrong: 5 min; each further wrong: 5 min; success clears). Data is never erased on failure. Nothing here logs a value.
 */
import { ethers } from 'ethers'
import { checkPasscodePolicy, type PasscodeReason } from './passcodeRules'
import { type AttemptState, ZERO_ATTEMPTS, afterFailure, afterRollback, gateAt, LOCK_MS } from './passcodeBackoff'
import type { AttemptRecordStore } from './passcodeWrapStore'
import { openMnemonicV3, openMnemonicV3WithKey, sealMnemonicV3WithKey } from './mnemonicCipherV3'
import { disablePasscodeThenSync } from '../passcodeDisableSync'
import { setPasscodeThenSync } from '../passcodeSetSync'
import { isShellContext } from '../shellContext'
import {
	type WrapRecord,
	VaultError,
	b64dec,
	b64enc,
	isLegacyWrapRecord,
	isWrapRecord,
	newSalt,
	passcodeWrapKey,
	randomBytes,
	unwrapField,
	utf8,
	utf8Decode,
	wrapField,
} from './walletWrap'

/** The mnemonic slot. Its record is the f1 mnemonic-cipher-format v3 envelope (decision), not a wallet-wrap record. */
const MNEMONIC_FIELD = 'mnemonicPhrase'

/**
 * Seals one slot under the account key. The mnemonic is the f1 mnemonic-cipher-format v3 envelope (sealMnemonicV3WithKey, decision
 * section 0). The other passcode fields (privateKeyArmor, pgpPrivateKeyArmored) keep the wallet wrap (walletWrap.wrapField),
 * same key and same salt, AAD bound to the field name and the account (decision). Every seal uses a new random IV.
 */
async function sealSlot(key: CryptoKey, salt: Uint8Array, slot: Slot, value: string): Promise<WrapRecord> {
	if (slot.field === MNEMONIC_FIELD) {
		const env = await sealMnemonicV3WithKey(key, salt, value, slot.eoa, randomBytes(12))
		if ('code' in env) throw new VaultError('mnemonic_seal_refused')
		return env as unknown as WrapRecord
	}
	return wrapField(key, value, slot.field, slot.eoa, salt)
}

/** Opens one record of a slot with the account key. The record must belong to the slot's account (eoa) and field. */
async function openRecordWithKey(key: CryptoKey, rec: WrapRecord, slot: Slot): Promise<string> {
	if (slot.field === MNEMONIC_FIELD) {
		const r = await openMnemonicV3WithKey(key, rec)
		if (r.code !== 'ok') throw new VaultError(r.code === 'unlock_failed' ? 'decrypt_failed' : 'verify_failed')
		return r.phrase
	}
	if (rec.eoa.toLowerCase() !== slot.eoa) throw new VaultError('decrypt_failed')
	return unwrapField(key, rec, slot.field, slot.eoa)
}

export type Loose = Record<string, any>

export interface WalletMeta {
	/** marker */
	walletWrapState?: 'wrapped'
	/** consecutive wrong passcodes; success resets */
	failures: number
	/** epoch ms before which passcode tries are refused (0 = none); the passcodeBackoff lockedUntilMs */
	nextAt: number
	/** epoch ms of the last recorded wrong passcode (0 = none); used to detect a clock that ran back */
	lastFailureMs?: number
}

export interface WalletStores {
	readInit(): Promise<Loose | null>
	/** A read before a save that does not move the write basis (shell). Optional: the browser reads the same way. */
	probeInit?(): Promise<Loose | null>
	/** Durable write of the init object; resolves after the store read-back accepted it. */
	writeInit(data: Loose): Promise<void>
	readMeta(): Promise<WalletMeta>
	writeMeta(m: WalletMeta): Promise<void>
	/** The cooldown record of one account (PWA IndexedDB, per EOA). Unit f3: the only counter of wrong passcodes. */
	attemptsFor(eoa: string): AttemptRecordStore
}

// ---------------------------------------------------------------------------
// Session (in memory only)
// ---------------------------------------------------------------------------

interface PasscodeSession {
	key: CryptoKey
	salt: Uint8Array
	acct: string
}

const session: { pc: PasscodeSession | null } = { pc: null }

export function lockWalletSession(): void {
	session.pc = null
}

export function resetWalletSession(): void {
	session.pc = null
}

export function passcodeSessionUnlocked(acct: string): boolean {
	return !!session.pc && session.pc.acct === acct.toLowerCase()
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
	// recoveryWords is not a slot (decision): it is the mnemonic's copy and is never written by this module; stored bytes are kept
	for (const field of ['mnemonicPhrase'] as const) {
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
	return slotsOf(data).some((s) => isWrapRecord(s.get(data)))
}

/** True when a slot holds a record of a removed format (v=1, PBKDF2, or device mode). Such a record is refused, never read. */
function legacyRecordsIn(data: Loose): boolean {
	return slotsOf(data).some((s) => isLegacyWrapRecord(s.get(data)))
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

function passcodeWrapper(key: CryptoKey, salt: Uint8Array) {
	return (slot: Slot, value: string): Promise<WrapRecord> => sealSlot(key, salt, slot, value)
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
	void stores
	try {
		if (legacyRecordsIn(data)) return { status: 'error', reason: 'verify_failed' }
		if (hasPlainSecrets(data)) return { status: 'loaded', data }
		if (hasWrappedSecrets(data)) {
			const acct = primaryAcct(data)
			if (!passcodeSessionUnlocked(acct)) return { status: 'locked' }
			const plain = await unwrapInPlace(data, async (slot, rec) => openRecordWithKey(session.pc!.key, rec, slot))
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

async function verifyWrapped(stores: WalletStores, plain: Loose, passKey: CryptoKey): Promise<void> {
	const back = await probeRead(stores)
	if (!back) throw new VaultError('readback_missing')
	const expected = slotsOf(plain)
	const got = slotsOf(back)
	for (let i = 0; i < expected.length; i++) {
		const want = expected[i].get(plain)
		if (!isSecretString(want)) continue
		const rec = got[i].get(back)
		if (!isWrapRecord(rec)) throw new VaultError('readback_mismatch')
		if ((await openRecordWithKey(passKey, rec, expected[i])) !== want) throw new VaultError('readback_mismatch')
	}
}

// ---------------------------------------------------------------------------
// Passcode lifecycle (six digits, Argon2id; cooldown by passcodeBackoff)
// ---------------------------------------------------------------------------

export type UnlockResult =
	| { ok: true; data: Loose }
	| { ok: false; reason: 'format' | 'no_passcode' | 'backoff' | 'wrong_passcode' | 'error'; retryAfterMs?: number; attempts?: number }

/** Six ASCII digits. Applied to the input of unlock only as a format check; the policy (checkPasscodePolicy) is for set and change. */
const PASSCODE_FORMAT = /^[0-9]{6}$/

/**
 * Checks the passcode (unit f3, 2026-11-22). Order: read the wallet (not counted); refuse while the per-account cooldown holds; count this
 * wrong-input attempt in one atomic update and read it back BEFORE judging it (a failed count or read-back refuses the attempt, the
 * passcode is not compared); then compare. Wrong: the count is kept and shown. Right: the record is cleared (deleted).
 * Cooldown: 3rd wrong locks for LOCK_MS; each further wrong locks again for LOCK_MS; a clock that ran back restarts the lock from now.
 */
export async function unlockWalletPasscode(stores: WalletStores, passcode: string, now = Date.now()): Promise<UnlockResult> {
	return unlockCore(stores, passcode, now, true)
}

/** `clearOnSuccess` false is used by disable: the cooldown is cleared only after the plaintext write and read-back (decision). */
async function unlockCore(stores: WalletStores, passcode: string, now: number, clearOnSuccess: boolean): Promise<UnlockResult> {
	if (!PASSCODE_FORMAT.test(passcode)) return { ok: false, reason: 'format' }
	const init = await probeRead(stores)
	if (init && legacyRecordsIn(init)) return { ok: false, reason: 'error' }
	if (!init || !passcodeRecordsIn(init)) return { ok: false, reason: 'no_passcode' }
	const acct = primaryAcct(init)
	const attempts = stores.attemptsFor(acct)
	const st: { decision: 'locked' | 'rolled_back' | 'counted' } = { decision: 'counted' }
	let counted: AttemptState | null
	try {
		counted = await attempts.update((prev) => {
			const s = prev ?? ZERO_ATTEMPTS
			const gate = gateAt(s, now)
			if (gate.kind === 'locked') {
				st.decision = gate.rolledBack ? 'rolled_back' : 'locked'
				return gate.rolledBack ? afterRollback(s, now) : s
			}
			st.decision = 'counted'
			return afterFailure(s, now)
		})
	} catch {
		return { ok: false, reason: 'error' }
	}
	if (st.decision !== 'counted') {
		const until = counted?.lockedUntilMs ?? now + LOCK_MS
		return { ok: false, reason: 'backoff', retryAfterMs: Math.max(0, until - now) }
	}
	// one salt and one key for the whole record: the mnemonic envelope's salt when present (it is sealed first), else the first wrap's
	const wraps = slotsOf(init).filter((x) => isWrapRecord(x.get(init)))
	const firstSlot = wraps.find((x) => x.field === MNEMONIC_FIELD) ?? wraps[0]
	const firstRec = firstSlot.get(init) as WrapRecord
	const salt = b64dec(firstRec.salt as string)
	const key = await passcodeWrapKey(passcode, salt)
	let plain: Loose | null = null
	try {
		plain = await unwrapInPlace(init, async (slot, rec) => openRecordWithKey(key, rec, slot))
	} catch {
		plain = null
	}
	if (!plain) {
		const failures = counted?.failures ?? 0
		const until = counted?.lockedUntilMs ?? 0
		return { ok: false, reason: 'wrong_passcode', retryAfterMs: until > now ? until - now : 0, attempts: failures }
	}
	if (clearOnSuccess) {
		try {
			await attempts.update(() => null)
		} catch {
			return { ok: false, reason: 'error' }
		}
	}
	session.pc = { key, salt, acct }
	return { ok: true, data: plain }
}

export type SetResult =
	| { ok: true }
	| { ok: false; reason: 'weak'; problem: PasscodeReason }
	| { ok: false; reason: 'locked' | 'error' | 'format' | 'no_passcode' | 'backoff' | 'wrong_passcode'; retryAfterMs?: number }
	/** The record is written and read back, but the shell has not confirmed the first sync: not a completed set (f3 follow-up, item 3). */
	| { ok: false; reason: 'sync_pending'; cipher: Loose }

/**
 * The first pwaWalletSync with the passcode (set or change). Injected by the product path (beamio.ts, f2's cipher sender); absent in
 * store-only use, where the step is skipped. Returns 'ok' only on the shell's confirmed read-back.
 */
export type FirstSyncWithPasscode = (envelope: Loose, passcode: string) => Promise<'ok' | 'not_completed'>

/**
 * Turns the passcode layer on (or replaces it when already on and unlocked). Policy is checked first. Order (passcodeSetSync, f2):
 * seal the mnemonic under the new passcode (f1 envelope) → open it again in memory with the same passcode and check phrase and account →
 * write the wallet record and read it back → the first pwaWalletSync with the cipher and the passcode; only a confirmed ok completes.
 */
export async function setWalletPasscode(stores: WalletStores, passcode: string, plain: Loose, firstSync?: FirstSyncWithPasscode): Promise<SetResult> {
	const check = checkPasscodePolicy(passcode)
	if (!check.ok) return { ok: false, reason: 'weak', problem: check.reason }
	if (!hasPlainSecrets(plain)) return { ok: false, reason: 'error' }
	const acct = primaryAcct(plain)
	const existing = await probeRead(stores)
	if (existing && passcodeRecordsIn(existing) && !passcodeSessionUnlocked(acct)) return { ok: false, reason: 'locked' }
	// In the shell, the first sync with the passcode is mandatory: without the injected step nothing is written (never a silent skip)
	if (!firstSync && isShellContext()) return { ok: false, reason: 'error' }
	const phrase = typeof plain.mnemonicPhrase === 'string' ? plain.mnemonicPhrase.trim() : ''
	let sealed: Loose | null = null
	let key: CryptoKey | null = null
	let salt: Uint8Array | null = null
	let wrapped: Loose | null = null
	let session_: PasscodeSession | null = null
	try {
		const outcome = await setPasscodeThenSync({ phrase, eoa: acct, passcode }, {
			seal: async (p, e, pc) => {
				salt = newSalt()
				key = await passcodeWrapKey(pc, salt)
				wrapped = await wrapInPlace(plain, passcodeWrapper(key, salt))
				const slot = slotsOf(wrapped).find((x) => x.field === MNEMONIC_FIELD)
				const env = slot ? slot.get(wrapped) : undefined
				if (!isWrapRecord(env) || p !== phrase || e !== acct) return null
				sealed = env as unknown as Loose
				return env as unknown as Record<string, unknown>
			},
			openInMemory: async (env, pc) => (await openMnemonicV3(env, pc)) as unknown as { code: string; phrase?: string; eoa?: string },
			writeRecord: async () => {
				try {
					await writeInitWithKeep(stores, wrapped!)
					await verifyWrapped(stores, plain, key!)
					session_ = { key: key!, salt: salt!, acct }
					session.pc = session_
					return true
				} catch {
					return false
				}
			},
			// the passcode is used in this one request only; it is not kept in the result or in any store
			firstSyncWithPasscode: async (env, pc) => (firstSync ? firstSync(env as unknown as Loose, pc) : 'ok'),
		})
		if (outcome === 'complete') return { ok: true }
		// the record was written and read back before the sync: the set is pending, not complete (the UI must not show it as on)
		if (outcome === 'sync_not_completed' && sealed) return { ok: false, reason: 'sync_pending', cipher: sealed }
		return { ok: false, reason: 'error' }
	} catch {
		return { ok: false, reason: 'error' }
	}
}

/** Change: the old passcode is checked first (counted), then the blob is re-wrapped under the new one. */
export async function changeWalletPasscode(
	stores: WalletStores,
	oldPasscode: string,
	newPasscode: string,
	now = Date.now(),
	firstSync?: FirstSyncWithPasscode,
): Promise<SetResult | UnlockResult> {
	const unlocked = await unlockWalletPasscode(stores, oldPasscode, now)
	if (!unlocked.ok) return unlocked
	return setWalletPasscode(stores, newPasscode, unlocked.data, firstSync)
}

/** Result of the plaintext wrap migration. Device-key migration is removed (unit f3); kept for the caller's type. */
export type PlainMigration = 'migrated' | 'kept' | 'none'

/**
 * Turn the passcode off (commit e442588 order, f2 passcodeDisableSync): verify, write plaintext and read back, replace the cipher, clear
 * the cooldown, then the background sync via syncPlain.
 */
export async function disableWalletPasscode(
	stores: WalletStores,
	passcode: string,
	now = Date.now(),
	syncPlain?: (phrase: string, eoa: string) => void,
): Promise<{ ok: true } | UnlockResult | { ok: false; reason: 'error' }> {
	// Order (decision, f2 passcodeDisableSync): verify the passcode → write the plaintext and read it back → replace the
	// ciphertext (the plain write replaces it; this step confirms no wrapped secret is left) → clear the cooldown → background pwaWalletSync.
	// The cooldown is not cleared by the unlock itself (clearOnSuccess false) so that the clear happens after the plaintext read-back.
	let unlocked: UnlockResult = { ok: false, reason: 'error' }
	let plain: Loose | null = null
	try {
		const init = await probeRead(stores)
		const eoa = init ? primaryAcct(init) : ''
		const outcome = await disablePasscodeThenSync(passcode, eoa, {
			verifyPasscode: async () => {
				unlocked = await unlockCore(stores, passcode, now, false)
				if (!unlocked.ok) return null
				plain = copyData(unlocked.data)
				const phrase = typeof plain.mnemonicPhrase === 'string' ? plain.mnemonicPhrase : ''
				return phrase || null
			},
			writePlainAndReadBack: async () => {
				try {
					await writeInitWithKeep(stores, plain!)
					const back = await probeRead(stores)
					return !!back && hasPlainSecrets(back) && !hasWrappedSecrets(back)
				} catch {
					return false
				}
			},
			replaceCipher: async () => {
				const back = await probeRead(stores)
				return !!back && !hasWrappedSecrets(back)
			},
			clearCooldown: async (eoa: string) => {
				await stores.attemptsFor(eoa).update(() => null)
			},
			syncPlain: (phrase: string, eoa: string) => {
				syncPlain?.(phrase, eoa)
			},
		})
		if (outcome === 'wrong_passcode') return unlocked.ok ? { ok: false, reason: 'error' } : unlocked
		if (outcome !== 'disabled') return { ok: false, reason: 'error' }
	} catch {
		return { ok: false, reason: 'error' }
	}
	lockWalletSession()
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
	const pcExisting = existingRecs.length > 0
	if (pcExisting && !passcodeSessionUnlocked(acct)) throw new VaultError('vault_locked')
	let out: Loose
	if (passcodeSessionUnlocked(acct)) {
		out = await wrapInPlace(plain, passcodeWrapper(session.pc!.key, session.pc!.salt))
	} else {
		// no-passcode state: the secrets are written as they are (no device key in this format)
		out = copyData(plain)
	}
	const merged = keepStoredRecoveryWords(keepStoredSecretsForEmptySlots(out, existing), existing)
	assertStoredSecretsKept(existing, merged)
	return merged
}

/**
 * The one write entry of the wallet store (0.53.39, independent review item 2). Every write of the init object goes through here:
 * a slot that is empty in the record keeps the stored value (keepStoredSecretsForEmptySlots), and a write that would lose a stored secret
 * is refused before anything is written (the data is kept; the caller gets an error).
 */
export async function writeInitWithKeep(stores: WalletStores, record: Loose): Promise<void> {
	const before = ((stores.probeInit ? await stores.probeInit() : await stores.readInit()) ?? {}) as Loose
	const merged = keepStoredRecoveryWords(keepStoredSecretsForEmptySlots(record, before), before)
	assertStoredSecretsKept(before, merged)
	await stores.writeInit(merged)
}

/**
 * The refusal (0.53.39, independent review item 1). Every stored secret (a key or a mnemonic, wrapped or plain) must be kept by the
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
 * recoveryWords is the mnemonic's copy (decision): this module never writes it. A stored value is kept byte for byte; a value
 * held in memory is not written. Pure: returns a copy.
 */
export function keepStoredRecoveryWords(out: Loose, before: Loose): Loose {
	const copy: Loose = { ...out }
	delete copy.recoveryWords
	if (before.recoveryWords !== undefined) copy.recoveryWords = before.recoveryWords
	return copy
}

/**
 * 0.53.39 (independent review): a slot that is empty in memory keeps the value already stored, whether that stored value is a
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

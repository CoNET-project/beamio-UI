/**
 * @jest-environment node
 *
 * plan A: the classification of the chain state. A working key is never stopped by a missing backup; a restore
 * stops on a missing or unopenable backup; a mismatched chain key stops any start; a failed read is only retried.
 */
import type { OwnChainRead } from './chatOwnRoutePlan'
import {
	classifyOwnPgp,
	getPgpRestoreFailure,
	getPgpRestoreSnapshot,
	isPgpRestoreFailure,
	setPgpRestoreFailure,
	snapshotOfRead,
	subscribePgpRestoreFailure,
} from './pgpRestore'

const ok = (privateBlob: 'ok' | 'missing' | 'error' | 'undecryptable', userKeyID = 'ABCDEF0123456789'): OwnChainRead => ({
	status: 'ok',
	userKeyID,
	routeKeyID: 'R',
	routeArmor: 'ARMOR',
	privateBlob,
})
const ERR: OwnChainRead = { status: 'error', reason: 'rpc' }
const EMPTY: OwnChainRead = { status: 'empty' }

describe('restore (no local key)', () => {
	it('an absent record is a new account (generation allowed)', () => {
		expect(classifyOwnPgp({ read: EMPTY, localKeyID: '', hasLocalKey: false })).toEqual({ kind: 'new_account' })
	})
	it('a record with a missing backup stops with pgp_backup_missing', () => {
		expect(classifyOwnPgp({ read: ok('missing'), localKeyID: '', hasLocalKey: false })).toEqual({ kind: 'failure', code: 'pgp_backup_missing' })
	})
	it('a record with an unopenable backup stops with pgp_backup_undecryptable', () => {
		expect(classifyOwnPgp({ read: ok('undecryptable'), localKeyID: '', hasLocalKey: false })).toEqual({
			kind: 'failure',
			code: 'pgp_backup_undecryptable',
		})
	})
	it('a readable backup restores (ok)', () => {
		expect(classifyOwnPgp({ read: ok('ok'), localKeyID: '', hasLocalKey: false })).toEqual({ kind: 'ok' })
	})
	it('a backup that failed to read is retried, never a failure', () => {
		expect(classifyOwnPgp({ read: ok('error'), localKeyID: '', hasLocalKey: false }).kind).toBe('read_error')
		expect(classifyOwnPgp({ read: ERR, localKeyID: '', hasLocalKey: false }).kind).toBe('read_error')
	})
})

describe('working account (local key present)', () => {
	it('a chain key that differs from the local key is pgp_fingerprint_mismatch (never overwritten)', () => {
		expect(classifyOwnPgp({ read: ok('ok', 'FFFFFFFFFFFFFFFF'), localKeyID: 'ABCDEF0123456789', hasLocalKey: true })).toEqual({
			kind: 'failure',
			code: 'pgp_fingerprint_mismatch',
		})
	})
	it('the comparison ignores case and surrounding space', () => {
		expect(classifyOwnPgp({ read: ok('ok', ' abcdef0123456789 '), localKeyID: 'ABCDEF0123456789', hasLocalKey: true })).toEqual({ kind: 'ok' })
	})
	it('a missing backup alone does not stop a working key', () => {
		expect(classifyOwnPgp({ read: ok('missing'), localKeyID: 'ABCDEF0123456789', hasLocalKey: true })).toEqual({ kind: 'ok' })
	})
	it('no record with a local key keeps the start as before', () => {
		expect(classifyOwnPgp({ read: EMPTY, localKeyID: 'ABCDEF0123456789', hasLocalKey: true })).toEqual({ kind: 'ok' })
	})
	it('a failed read is retried', () => {
		expect(classifyOwnPgp({ read: ERR, localKeyID: 'ABCDEF0123456789', hasLocalKey: true }).kind).toBe('read_error')
	})
})

describe('the state shown is the state the user confirms (snapshot)', () => {
	it('an error or an empty record has its own snapshot', () => {
		expect(snapshotOfRead(ERR)).toBe('error')
		expect(snapshotOfRead(EMPTY)).toBe('empty')
	})
	it('the same chain state gives the same snapshot (case and space ignored)', () => {
		expect(snapshotOfRead(ok('missing', ' abcdef0123456789 '))).toBe(snapshotOfRead(ok('missing', 'ABCDEF0123456789')))
	})
	it('a changed user key, route or backup gives another snapshot', () => {
		const base = snapshotOfRead(ok('missing'))
		const otherRoute: OwnChainRead = { status: 'ok', userKeyID: 'ABCDEF0123456789', routeKeyID: 'S', routeArmor: 'ARMOR', privateBlob: 'missing' }
		expect(snapshotOfRead(ok('missing', 'FFFFFFFFFFFFFFFF'))).not.toBe(base)
		expect(snapshotOfRead(otherRoute)).not.toBe(base)
		expect(snapshotOfRead(ok('ok'))).not.toBe(base)
		expect(snapshotOfRead(ERR)).not.toBe(base)
	})
	it('the store keeps the snapshot with the failure, and drops it when cleared', () => {
		const snap = snapshotOfRead(ok('missing'))
		setPgpRestoreFailure('pgp_backup_missing', snap)
		expect(getPgpRestoreSnapshot()).toBe(snap)
		setPgpRestoreFailure(null)
		expect(getPgpRestoreSnapshot()).toBeNull()
		expect(getPgpRestoreFailure()).toBeNull()
	})
	it('a failure without a snapshot has none, so the user click refuses', () => {
		setPgpRestoreFailure('pgp_backup_missing')
		expect(getPgpRestoreSnapshot()).toBeNull()
		setPgpRestoreFailure(null)
	})
})

describe('codes and the store', () => {
	it('only the three codes are restore failures', () => {
		expect(isPgpRestoreFailure('pgp_backup_missing')).toBe(true)
		expect(isPgpRestoreFailure('pgp_backup_undecryptable')).toBe(true)
		expect(isPgpRestoreFailure('pgp_fingerprint_mismatch')).toBe(true)
		expect(isPgpRestoreFailure('bad_request')).toBe(false)
		expect(isPgpRestoreFailure(undefined)).toBe(false)
	})

	it('the store notifies a change, and stops after unsubscribe', () => {
		const seen: Array<string | null> = []
		const off = subscribePgpRestoreFailure((v) => seen.push(v))
		setPgpRestoreFailure('pgp_backup_missing')
		setPgpRestoreFailure('pgp_backup_missing')
		setPgpRestoreFailure(null)
		off()
		setPgpRestoreFailure('pgp_fingerprint_mismatch')
		expect(seen).toEqual(['pgp_backup_missing', null])
		expect(getPgpRestoreFailure()).toBe('pgp_fingerprint_mismatch')
		setPgpRestoreFailure(null)
	})
})

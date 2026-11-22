/**
 * @jest-environment node
 *
 * Entry-level evidence: the real exported storage entry (checkStorageWithStatus → readStorageWithStatus) with the shell
 * build flag on, the shell record read answered not_supported (a definite absence), and the legacy page store (PouchDB 'init')
 * answered absent / valid / unknown. Non-fallback shells (a timeout) are checked to be unchanged.
 */
import { ethers } from 'ethers'

const mockPouch: { docs: Record<string, { title: string }>; mode: 'normal' | 'unknown' } = { docs: {}, mode: 'normal' }

jest.mock('pouchdb', () => {
	const factory = () => ({
		get: async (id: string) => {
			if (mockPouch.mode === 'unknown') throw Object.assign(new Error('boom'), { status: 500, name: 'unknown_error' })
			const d = mockPouch.docs[id]
			if (!d) throw Object.assign(new Error('missing'), { status: 404, name: 'not_found' })
			return { _id: id, title: d.title }
		},
		put: async (doc: { _id: string; title: string }) => {
			mockPouch.docs[doc._id] = { title: doc.title }
			return { ok: true, id: doc._id, rev: '1-x' }
		},
		remove: async () => ({ ok: true }),
		allDocs: async () => ({ rows: [] }),
		info: async () => ({}),
	})
	return { __esModule: true, default: factory }
})

jest.mock('./argon2WorkerBridge', () => ({ argon2idAsync: jest.fn() }))
jest.mock('./walletEoaAddress', () => ({ readWalletEoaAddress: jest.fn(async () => ({ kind: 'refused', code: 'not_supported' })) }))
jest.mock('./chatWorkerBridge', () => ({}))
jest.mock('./chatMediaWorkerBridge', () => ({}))
jest.mock('../workers/beamioTag/client', () => ({}))

jest.mock('./shellRecordStore', () => {
	const actual = jest.requireActual('./shellRecordStore')
	return { ...actual, shellRecordRead: jest.fn() }
})

import { encodeInitRaw } from './initRecordCodec'
import { checkStorageWithStatus } from './beamio'
import { shellRecordFallbackLabel } from './shellRecordFallback'
import { shellRecordRead } from './shellRecordStore'
import { readWalletEoaAddress } from './walletEoaAddress'

const readMock = shellRecordRead as unknown as jest.Mock

function legacyInitTitle(): string {
	const w = ethers.Wallet.createRandom()
	return encodeInitRaw({ mnemonicPhrase: w.mnemonic!.phrase, profiles: [{ keyID: w.address.toLowerCase() }] })
}

beforeAll(() => {
	process.env.REACT_APP_SHELL_BUILD = 'true'
})

beforeEach(() => {
	mockPouch.docs = {}
	mockPouch.mode = 'normal'
	readMock.mockReset()
	;(readWalletEoaAddress as unknown as jest.Mock).mockClear()
})

describe('the real entry on a fallback shell (shellRecordRead not_supported)', () => {
	beforeEach(() => {
		readMock.mockResolvedValue({ status: 'error', reason: 'not_supported' })
	})

	test('legacy page store holds an account → loaded (enter /chat)', async () => {
		mockPouch.docs.init = { title: legacyInitTitle() }
		const r = await checkStorageWithStatus()
		expect(r.status).toBe('loaded')
	})

	test('legacy page store confirmed empty → the terminal update prompt (never onboarding, never entered)', async () => {
		const r = await checkStorageWithStatus()
		expect(r).toEqual({ status: 'unavailable', reason: 'old_shell_upgrade_required' })
	})

	test('legacy read failure → wait (retry), never the terminal and never onboarding', async () => {
		mockPouch.mode = 'unknown'
		const r = await checkStorageWithStatus()
		expect(r).toEqual({ status: 'unavailable', reason: 'native_retry' })
	})

	test('the fallback path never consults walletEoaAddress (f71f5be6, review)', async () => {
		await checkStorageWithStatus()
		expect(readWalletEoaAddress).not.toHaveBeenCalled()
	})

	test('unsupported unknown_command (iOS) takes the same path', async () => {
		readMock.mockResolvedValue({ status: 'error', reason: 'unknown_command' })
		const r = await checkStorageWithStatus()
		expect(r).toEqual({ status: 'unavailable', reason: 'old_shell_upgrade_required' })
	})

	test('iOS unknown_command: the diagnostic names the shell reply unknown_command, never not_supported', async () => {
		readMock.mockResolvedValue({ status: 'error', reason: 'unknown_command' })
		const info = jest.spyOn(console, 'info').mockImplementation(() => {})
		try {
			await checkStorageWithStatus()
			const lines = info.mock.calls.map((c) => String(c[0]))
			const fallback = lines.find((l) => l.includes('fallback shell'))
			expect(fallback).toBeDefined()
			expect(fallback).toContain('unknown_command')
			expect(fallback).not.toContain('not_supported')
			expect(shellRecordFallbackLabel()).toBe('unknown_command')
		} finally {
			info.mockRestore()
		}
	})

	test('Android not_supported: the diagnostic names not_supported and nothing else', async () => {
		readMock.mockResolvedValue({ status: 'error', reason: 'not_supported' })
		const info = jest.spyOn(console, 'info').mockImplementation(() => {})
		try {
			await checkStorageWithStatus()
			const fallback = info.mock.calls.map((c) => String(c[0])).find((l) => l.includes('fallback shell'))
			expect(fallback).toContain('not_supported')
			expect(fallback).not.toContain('unknown_command')
			expect(shellRecordFallbackLabel()).toBe('not_supported')
		} finally {
			info.mockRestore()
		}
	})
})

describe('a non-fallback shell is unchanged', () => {
	test('a shell record timeout is a hold with the existing reason, never the terminal', async () => {
		readMock.mockResolvedValue({ status: 'error', reason: 'timeout' })
		mockPouch.docs.init = { title: legacyInitTitle() }
		const r = await checkStorageWithStatus()
		expect(r.status).toBe('unavailable')
		expect((r as { reason?: string }).reason).not.toBe('old_shell_upgrade_required')
	})

	test('untrusted_source is never the fallback: no page entry, no empty, no onboarding, wait (native_retry) (7590d172)', async () => {
		readMock.mockResolvedValue({ status: 'error', reason: 'untrusted_source' })
		mockPouch.docs.init = { title: legacyInitTitle() }
		const r = await checkStorageWithStatus()
		expect(r).toEqual({ status: 'unavailable', reason: 'native_retry' })
		expect(readWalletEoaAddress).not.toHaveBeenCalled()
	})

	test('untrusted_source with a confirmed-empty page store: not the update prompt, not onboarding (native_retry)', async () => {
		readMock.mockResolvedValue({ status: 'error', reason: 'untrusted_source' })
		const r = await checkStorageWithStatus()
		expect(r).toEqual({ status: 'unavailable', reason: 'native_retry' })
		expect(r).not.toEqual({ status: 'empty' })
	})

	test('untrusted_source: the diagnostic names untrusted_source and the page store is not read', async () => {
		readMock.mockResolvedValue({ status: 'error', reason: 'untrusted_source' })
		const info = jest.spyOn(console, 'info').mockImplementation(() => {})
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
		try {
			await checkStorageWithStatus()
			const lines = [...info.mock.calls, ...warn.mock.calls].map((c) => String(c[0]))
			expect(lines.some((l) => l.includes('untrusted_source') && l.includes('page store not read'))).toBe(true)
			expect(lines.some((l) => l.includes('fallback shell'))).toBe(false)
		} finally {
			info.mockRestore()
			warn.mockRestore()
		}
	})

	test('locked stays a hold on the page too: a valid page account does not enter', async () => {
		readMock.mockResolvedValue({ status: 'error', reason: 'locked' })
		mockPouch.docs.init = { title: legacyInitTitle() }
		const r = await checkStorageWithStatus()
		expect(r.status).not.toBe('loaded')
		expect(r).toEqual({ status: 'unavailable', reason: 'native_locked' })
	})
})

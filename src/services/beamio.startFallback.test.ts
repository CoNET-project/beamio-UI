/**
 * @jest-environment node
 *
 * Entry-level evidence (2026-11-21): the real exported storage entry (checkStorageWithStatus → readStorageWithStatus) with the shell
 * build flag on, the shell record read answered not_supported (a definite absence), and the legacy page store (PouchDB 'init')
 * answered absent / valid / unknown. Non-fallback shells (a timeout) are checked to be unchanged.
 *
 * 改写说明（IDB 先读，the decision）：普通启动（非 probe）先读页面 IDB；页面有效则进入，页面明确缺失则返回 empty，
 * 由网关在页面 IDB 明确缺失后再调 nativeMnemonicPreread。因此原生记录命令（shellRecordRead）的 not_supported / unknown_command /
 * untrusted_source / locked / timeout 判定，改由 `{ probe: true }` 走原生先读路径验证（产品未改变该路径的判定）。
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

// 模块加载桩：beamio.ts 静态导入 argon2WorkerBridge（其模块体含 import.meta，Jest 无法加载）。本用例不走 KDF，不提供 argon2idAsync。
jest.mock('./argon2WorkerBridge', () => ({}))
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
		// IDB 先读：页面有效即进入，原生记录未被查询
		expect(readMock).not.toHaveBeenCalled()
	})

	test('legacy page store confirmed empty at the entry → empty (never entered, never the native record); the gate then asks the pre-read', async () => {
		// 改写：原断言为 unavailable/old_shell_upgrade_required（原生先读路径）。IDB 先读下，页面明确缺失返回 empty，原生记录不被查询
		const r = await checkStorageWithStatus()
		expect(r).toEqual({ status: 'empty' })
		expect(readMock).not.toHaveBeenCalled()
	})

	test('legacy page store confirmed empty on the native-first path (probe) → the terminal update prompt (never onboarding, never entered)', async () => {
		// 改写：原“落 terminal”意图保留，前提改为原生先读路径（probe）；页面确认为空，原生 not_supported 为定论 → 终端更新提示
		const r = await checkStorageWithStatus({ probe: true })
		expect(r).toEqual({ status: 'unavailable', reason: 'old_shell_upgrade_required' })
	})

	test('legacy read failure → wait (retry), never the terminal and never onboarding', async () => {
		mockPouch.mode = 'unknown'
		const r = await checkStorageWithStatus()
		expect(r).toEqual({ status: 'unavailable', reason: 'native_retry' })
	})

	test('the fallback path never consults walletEoaAddress (f71f5be6, review)', async () => {
		await checkStorageWithStatus()
		await checkStorageWithStatus({ probe: true })
		expect(readWalletEoaAddress).not.toHaveBeenCalled()
	})

	test('unsupported unknown_command (iOS) takes the same path (native-first, probe)', async () => {
		readMock.mockResolvedValue({ status: 'error', reason: 'unknown_command' })
		const r = await checkStorageWithStatus({ probe: true })
		expect(r).toEqual({ status: 'unavailable', reason: 'old_shell_upgrade_required' })
	})

	test('iOS unknown_command: the diagnostic names the shell reply unknown_command, never not_supported', async () => {
		readMock.mockResolvedValue({ status: 'error', reason: 'unknown_command' })
		const info = jest.spyOn(console, 'info').mockImplementation(() => {})
		try {
			await checkStorageWithStatus({ probe: true })
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
			await checkStorageWithStatus({ probe: true })
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
	test('a shell record timeout is a hold with the existing reason, never the terminal (native-first, probe)', async () => {
		readMock.mockResolvedValue({ status: 'error', reason: 'timeout' })
		mockPouch.docs.init = { title: legacyInitTitle() }
		const r = await checkStorageWithStatus({ probe: true })
		expect(r.status).toBe('unavailable')
		expect((r as { reason?: string }).reason).not.toBe('old_shell_upgrade_required')
	})

	test('a valid page account enters at the entry even when the native record would time out (IDB 先读，不查原生)', async () => {
		// 改写：原断言为 unavailable（原生先读）。IDB 先读下页面有效即 loaded，原生记录不被查询
		readMock.mockResolvedValue({ status: 'error', reason: 'timeout' })
		mockPouch.docs.init = { title: legacyInitTitle() }
		const r = await checkStorageWithStatus()
		expect(r.status).toBe('loaded')
		expect(readMock).not.toHaveBeenCalled()
	})

	test('untrusted_source is never the fallback: no page entry, no empty, no onboarding, wait (native_retry) (7590d172)', async () => {
		readMock.mockResolvedValue({ status: 'error', reason: 'untrusted_source' })
		mockPouch.docs.init = { title: legacyInitTitle() }
		const r = await checkStorageWithStatus({ probe: true })
		expect(r).toEqual({ status: 'unavailable', reason: 'native_retry' })
		expect(readWalletEoaAddress).not.toHaveBeenCalled()
	})

	test('untrusted_source with a confirmed-empty page store: not the update prompt, not onboarding (native_retry, probe)', async () => {
		readMock.mockResolvedValue({ status: 'error', reason: 'untrusted_source' })
		const r = await checkStorageWithStatus({ probe: true })
		expect(r).toEqual({ status: 'unavailable', reason: 'native_retry' })
		expect(r).not.toEqual({ status: 'empty' })
	})

	test('untrusted_source: the diagnostic names untrusted_source and the page store is not read (probe)', async () => {
		readMock.mockResolvedValue({ status: 'error', reason: 'untrusted_source' })
		const info = jest.spyOn(console, 'info').mockImplementation(() => {})
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
		try {
			await checkStorageWithStatus({ probe: true })
			const lines = [...info.mock.calls, ...warn.mock.calls].map((c) => String(c[0]))
			expect(lines.some((l) => l.includes('untrusted_source') && l.includes('page store not read'))).toBe(true)
			expect(lines.some((l) => l.includes('fallback shell'))).toBe(false)
		} finally {
			info.mockRestore()
			warn.mockRestore()
		}
	})

	test('locked stays a hold on the native-first path: a valid page account does not enter there (probe)', async () => {
		readMock.mockResolvedValue({ status: 'error', reason: 'locked' })
		mockPouch.docs.init = { title: legacyInitTitle() }
		const r = await checkStorageWithStatus({ probe: true })
		expect(r.status).not.toBe('loaded')
		expect(r).toEqual({ status: 'unavailable', reason: 'native_locked' })
	})
})

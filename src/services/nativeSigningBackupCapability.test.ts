/**
 * @jest-environment node
 *
 * (MERGE-EDITS A23): walletBackupView is gated by wallet.backup-view.v1. Four combinations (BC-1…BC-4, my own naming):
 * BC-1 native-keys declared, backup-view not declared: no command is sent, the neutral copy.
 * BC-2 both declared, the command is acknowledged ok: ok.
 * BC-3 both declared, the command answers unknown_command: the neutral copy (not the raw reason).
 * BC-4 native-keys not declared: the previous behaviour (no command is sent; native_unavailable), mapped to the neutral failure copy.
 */
jest.mock('./nativeChatRouteRegister', () => ({ probeNativeCapabilities: jest.fn(), requestNativeAck: jest.fn() }))

import { probeNativeCapabilities, requestNativeAck } from './nativeChatRouteRegister'
import { backupViewErrorKey, nativeWalletBackupView } from './nativeSigning'

const KEYS = 'identity.native-keys.v1'
const BACKUP = 'wallet.backup-view.v1'

describe('walletBackupView capability gate (BC)', () => {
	beforeEach(() => {
		;(probeNativeCapabilities as jest.Mock).mockReset()
		;(requestNativeAck as jest.Mock).mockReset()
	})

	it('BC-1: native-keys declared, wallet.backup-view.v1 not declared: no command sent, neutral update copy', async () => {
		;(probeNativeCapabilities as jest.Mock).mockResolvedValue({ answered: true, capabilities: [KEYS] })
		const out = await nativeWalletBackupView('privateKey')
		expect(out).toEqual({ ok: false, reason: 'unsupported_build' })
		expect(requestNativeAck).not.toHaveBeenCalled()
		expect(backupViewErrorKey('unsupported_build')).toBe('native_backup_view_unsupported')
	})

	it('BC-2: both declared, the command is acknowledged ok', async () => {
		;(probeNativeCapabilities as jest.Mock).mockResolvedValue({ answered: true, capabilities: [KEYS, BACKUP] })
		;(requestNativeAck as jest.Mock).mockResolvedValue({ kind: 'payload', payload: { type: 'ack', ok: true, result: {} } })
		expect(await nativeWalletBackupView('mnemonic')).toEqual({ ok: true })
		expect(requestNativeAck).toHaveBeenCalledTimes(1)
	})

	it('BC-3: both declared, the command answers unknown_command: the neutral copy, never the raw reason', async () => {
		;(probeNativeCapabilities as jest.Mock).mockResolvedValue({ answered: true, capabilities: [KEYS, BACKUP] })
		;(requestNativeAck as jest.Mock).mockResolvedValue({ kind: 'payload', payload: { type: 'ack', ok: false, error: 'unknown_command' } })
		const out = await nativeWalletBackupView('recoveryCode')
		expect(out).toEqual({ ok: false, reason: 'unsupported_build' })
		expect(backupViewErrorKey(out.ok ? '' : out.reason)).toBe('native_backup_view_unsupported')
	})

	it('BC-4: native-keys not declared: no command sent; the failure maps to the neutral failure copy (no raw reason)', async () => {
		;(probeNativeCapabilities as jest.Mock).mockResolvedValue({ answered: true, capabilities: [] })
		const out = await nativeWalletBackupView('privateKey')
		expect(out.ok).toBe(false)
		expect(requestNativeAck).not.toHaveBeenCalled()
		expect(backupViewErrorKey(out.ok ? '' : out.reason)).toBe('native_backup_view_failed')
	})
})

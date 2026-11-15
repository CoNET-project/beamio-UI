/**
 * Card UID read (NTAG 424 DNA).
 * - Browser: Web NFC (`NDEFReader`), Chrome Android over HTTPS with a user gesture.
 * - Native shell: the neutral shell read (`nativeNfcUidRead`,  2026-11-13). Web NFC is not used there.
 * Callers get the UID as before; the shell read has no bind meaning.
 */
import { useState, useCallback } from 'react'
import { isShellContext } from '@/services/shellContext'
import { nativeNfcUidRead } from '@/services/nativeNfcUidRead'

/** User-facing text for a failed shell read. A cancel is not an error. */
function shellReadErrorText(reason: string): string {
	switch (reason) {
		case 'no_hardware':
		case 'disabled':
		case 'unsupported':
		case 'native_unavailable':
			return 'NFC 不可用'
		case 'permission_denied':
			return 'NFC 权限被拒绝，请在系统设置中开启'
		case 'invalid_tag':
			return '无法识别该 NFC 卡'
		case 'timeout':
			return '读取超时，请重试'
		default:
			return 'NFC 读取失败，请重试'
	}
}

declare global {
	interface NDEFReadingEvent extends Event {
		serialNumber: string
		message?: unknown
	}

	interface NDEFReader extends EventTarget {
		read(): Promise<void>
		onreading: ((event: NDEFReadingEvent) => void) | null
	}

	interface Window {
		NDEFReader?: new () => NDEFReader
	}
}

export function useNfcRead() {
	const [status, setStatus] = useState<'idle' | 'reading' | 'success' | 'error'>('idle')
	const [uid, setUid] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)

	const readUid = useCallback(async (): Promise<string | null> => {
		setStatus('reading')
		setError(null)
		setUid(null)

		if (isShellContext()) {
			const r = await nativeNfcUidRead()
			if (r.ok) {
				setUid(r.uid)
				setStatus('success')
				return r.uid
			}
			if (r.reason === 'cancelled') {
				setStatus('idle')
				return null
			}
			setError(shellReadErrorText(r.reason))
			setStatus('error')
			return null
		}

		if (!('NDEFReader' in window)) {
			setError('NFC 不可用，请使用 Chrome Android 并确保 HTTPS')
			setStatus('error')
			return null
		}

		try {
			const reader = new (window as any).NDEFReader()
			return new Promise((resolve) => {
				reader.onreading = (event: NDEFReadingEvent) => {
					const serial = event.serialNumber || ''
					// serialNumber 格式：hex 字符串，如 "04A1B2C3D4E5F6"
					const uidHex = serial.length > 0 ? serial : ''
					setUid(uidHex)
					setStatus('success')
					resolve(uidHex)
				}
				reader.onerror = () => {
					setError('读取失败，请重试')
					setStatus('error')
					resolve(null)
				}
				reader.read().catch((err: Error) => {
					setError(err?.message ?? 'NFC 读取失败')
					setStatus('error')
					resolve(null)
				})
			})
		} catch (err) {
			const msg = (err as Error)?.message ?? 'NFC 不可用'
			setError(msg)
			setStatus('error')
			return null
		}
	}, [])

	const reset = useCallback(() => {
		setStatus('idle')
		setUid(null)
		setError(null)
	}, [])

	return { readUid, uid, status, error, reset }
}

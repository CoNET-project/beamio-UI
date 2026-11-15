import { SHELL_TIMEOUT, hasBeamioShell, requestBeamioShell } from './beamioShellChannel'
declare global {
  interface Window {
    CashTreesIOS?: {
      scanQr?: (payload: { requestId: string }) => void
      scanRecoveryQr?: (payload: { requestId: string }) => void
      getEmbeddedPwaVersion?: () => string
      getEmbeddedPwaPendingVersion?: () => string
      applyEmbeddedPwaUpdate?: () => void
      publishAppState?: (state: Record<string, unknown>) => void
      /** Tray only; icon badge stays unread via publishAppState */
      clearOfflineChatAlerts?: () => void
      /** Local alert + badge while shell is behind Home */
      notifyBackgroundChat?: (payload: {
        badge?: number
        appIconBadge?: number
        title?: string
        body?: string
      }) => void
      bindPushIdentity?: (payload: { eoa: string; pgpKeyId?: string }) => void
      setNativeSiNodeRoster?: (payload: {
        siNodes?: { ip: string; domain?: string; region?: string }[]
        mailboxIp?: string
      }) => void
      postPgpCiphertext?: (payload: {
        requestId: string
        data: string
        excludeIps?: string[]
      }) => void
      /**
       * iOS Conet Chat Module (1B): PWA posts WorkerCommand JSON; native owns
       * OpenPGP / SSE / SI. EOA signing stays on the PWA via chatModuleSignRequest.
       */
      chatModuleCommand?: (payload: Record<string, unknown>) => void
      chatModuleSignResponse?: (payload: {
        reqId: number
        ok: boolean
        signature?: string
        error?: string
      }) => void
      debugLog?: (level: string, message: string) => void
      openURL?: (payload: { url: string }) => void
      listInstalledWalletApps?: (payload: { requestId: string }) => void
    }
    CashTreesAndroid?: {
      getNfcStatus?: () => string
      scanQr?: (requestId: string) => void
      scanRecoveryQr?: (requestId: string) => void
      openURL?: (url: string) => void
      getEmbeddedPwaVersion?: () => string
      getEmbeddedPwaPendingVersion?: () => string
      applyEmbeddedPwaUpdate?: () => void
      publishAppState?: (json: string) => void
      /** Tray only; icon badge stays unread via publishAppState */
      clearOfflineChatAlerts?: () => void
      /** JSON string `{ badge, title?, body? }` — local alert while backgrounded */
      notifyBackgroundChat?: (json: string) => void
      /** JSON string `{ eoa, pgpKeyId? }` — FCM bind */
      bindPushIdentity?: (json: string) => void
      setNativeSiNodeRoster?: (json: string) => void
      postPgpCiphertext?: (json: string) => void
      debugLog?: (level: string, message: string) => void
      listInstalledWalletApps?: () => string
    }
  }
}

export type CashTreesScanQrResult =
  | { ok: true; text: string }
  | { ok: false; error?: string; cancelled?: boolean }

type NativeScanPlatform = 'ios' | 'android'

function detectNativeScanPlatform(): NativeScanPlatform | null {
  if (typeof window === 'undefined') return null
  if (typeof window.CashTreesIOS?.scanQr === 'function') return 'ios'
  if (hasBeamioShell()) return 'android'
  if (typeof window.CashTreesAndroid?.scanQr === 'function') return 'android'
  return null
}

export function isEmbeddedCashTreesWebView(): boolean {
  if (typeof window === 'undefined') return false
  if (window.CashTreesIOS) return true
  if (window.CashTreesAndroid || hasBeamioShell()) return true
  const webkitBridge = (window as Window & {
    webkit?: {
      messageHandlers?: Record<string, unknown>
    }
  }).webkit
  return !!webkitBridge?.messageHandlers?.CashTreesIOS
}

/**
 * Native WebView shell (CashTreesIOS / CashTreesAndroid / WK handler).
 * Broader than {@link detectNativeScanPlatform} (which requires `scanQr`).
 * Chat and other features must use this — never spawn chat-sdk Worker when true.
 */
export function isCashTreesNativeWebView(): boolean {
  return isEmbeddedCashTreesWebView()
}

export function scanQrViaCashTreesNative(timeoutMs = 120_000): Promise<CashTreesScanQrResult> {
  return new Promise((resolve) => {
    const platform = detectNativeScanPlatform()
    if (!platform) {
      resolve({ ok: false, error: 'native_unavailable' })
      return
    }

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const eventName = platform === 'ios' ? 'cashtreesios' : 'cashtreesandroid'

    const finish = (result: CashTreesScanQrResult) => {
      window.removeEventListener(eventName, onEvent)
      clearTimeout(timer)
      resolve(result)
    }

    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        action?: string
        ok?: boolean
        requestId?: string
        text?: string
        error?: string
      }
      if (!detail || detail.action !== 'scanQr' || detail.requestId !== requestId) return

      if (detail.ok && typeof detail.text === 'string') {
        finish({ ok: true, text: detail.text })
        return
      }

      finish({
        ok: false,
        error: detail.error || 'scan_failed',
        cancelled: detail.error === 'cancelled',
      })
    }

    const timer = setTimeout(() => {
      finish({ ok: false, error: 'timeout' })
    }, timeoutMs)

    window.addEventListener(eventName, onEvent)

    try {
      if (platform === 'ios') {
        window.CashTreesIOS!.scanQr!({ requestId })
      } else if (hasBeamioShell()) {
        // the result still comes on the cashtreesandroid event; the ack only refuses.
        void requestBeamioShell('scanQr', { requestId }).then((ack) => {
          if (!ack.ok && ack.error !== SHELL_TIMEOUT) finish({ ok: false, error: ack.error })
        })
      } else {
        window.CashTreesAndroid!.scanQr!(requestId)
      }
    } catch (err) {
      finish({
        ok: false,
        error: err instanceof Error ? err.message : 'scan_failed',
      })
    }
  })
}

export {}

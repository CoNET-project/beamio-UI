/**
 * Embedded PWA OTA (iOS WKWebView + Android WebViewAssetLoader).
 *
 * Store builds do not run OTA (ota-pwa-protocol.md, 0.52.935): they inject no
 * apply bridge and declare no capability. The PWA shows no update prompt and
 * never calls the apply bridge unless BOTH the bridge function exists AND the
 * shell declares `pwa.embedded-ota.v1` (internal test builds only).
 */

export type EmbeddedPwaUpdateDetail = {
  currentVer: string
  pendingVer: string
}

export type ApplyEmbeddedPwaUpdateDetail = {
  ok: boolean
  ver?: string
  error?: string
  reason?: string
}

export const EMBEDDED_PWA_OTA_CAPABILITY = 'pwa.embedded-ota.v1'

/** The shell replied `reason: "not_supported"`; OTA is off for this session. */
const NOT_SUPPORTED_REASON = 'not_supported'

let otaTurnedOffThisSession = false

/** Called when a shell reports OTA as not supported: hide the prompt for this session. */
export function markEmbeddedPwaOtaNotSupported(): void {
  otaTurnedOffThisSession = true
}

const IOS_BRIDGE_EVENT = 'cashtreesios'
const ANDROID_BRIDGE_EVENT = 'cashtreesandroid'

function isIosEmbeddedPwaBridgeReady(): boolean {
  if (typeof window === 'undefined') return false
  return typeof window.CashTreesIOS?.applyEmbeddedPwaUpdate === 'function'
}

function isAndroidEmbeddedPwaBridgeReady(): boolean {
  if (typeof window === 'undefined') return false
  return typeof window.CashTreesAndroid?.applyEmbeddedPwaUpdate === 'function'
}

/**
 * The shell declares the capability as a boolean on a window global:
 * `window.__CT_IOS_CAPS__['pwa.embedded-ota.v1'] === true` (iOS, agreed with the iOS shell)
 * or `window.__CT_ANDROID_CAPS__['pwa.embedded-ota.v1'] === true` (Android, same name).
 */
function hasEmbeddedPwaOtaCapability(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as unknown as {
    __CT_IOS_CAPS__?: Record<string, unknown>
    __CT_ANDROID_CAPS__?: Record<string, unknown>
  }
  return (
    w.__CT_IOS_CAPS__?.[EMBEDDED_PWA_OTA_CAPABILITY] === true ||
    w.__CT_ANDROID_CAPS__?.[EMBEDDED_PWA_OTA_CAPABILITY] === true
  )
}

/**
 * True only when a shell has both the apply bridge and the OTA capability, and
 * the session has not been told `not_supported`.
 */
export function isEmbeddedPwaOtaSupported(): boolean {
  if (otaTurnedOffThisSession) return false
  if (!hasEmbeddedPwaOtaCapability()) return false
  return isIosEmbeddedPwaBridgeReady() || isAndroidEmbeddedPwaBridgeReady()
}

/** @deprecated Prefer `isEmbeddedPwaOtaSupported()`. */
export function isIosEmbeddedPwaOtaSupported(): boolean {
  return isIosEmbeddedPwaBridgeReady()
}

export function isAndroidEmbeddedPwaOtaSupported(): boolean {
  return isAndroidEmbeddedPwaBridgeReady()
}

export function readEmbeddedPwaVersion(): string {
  if (isIosEmbeddedPwaBridgeReady()) {
    return window.CashTreesIOS?.getEmbeddedPwaVersion?.() ?? ''
  }
  if (isAndroidEmbeddedPwaBridgeReady()) {
    return window.CashTreesAndroid?.getEmbeddedPwaVersion?.() ?? ''
  }
  return ''
}

export function readEmbeddedPwaPendingVersion(): string {
  if (isIosEmbeddedPwaBridgeReady()) {
    return window.CashTreesIOS?.getEmbeddedPwaPendingVersion?.() ?? ''
  }
  if (isAndroidEmbeddedPwaBridgeReady()) {
    return window.CashTreesAndroid?.getEmbeddedPwaPendingVersion?.() ?? ''
  }
  return ''
}

export function requestEmbeddedPwaUpdateApply(): void {
  if (!isEmbeddedPwaOtaSupported()) return
  if (isIosEmbeddedPwaBridgeReady()) {
    window.CashTreesIOS?.applyEmbeddedPwaUpdate?.()
    return
  }
  if (isAndroidEmbeddedPwaBridgeReady()) {
    window.CashTreesAndroid?.applyEmbeddedPwaUpdate?.()
  }
}

function subscribeBridgeEvent(
  eventName: string,
  predicate: (detail: Record<string, unknown>) => boolean,
  listener: (detail: Record<string, unknown>) => void,
): () => void {
  const onEvent = (event: Event) => {
    const detail = (event as CustomEvent).detail as Record<string, unknown>
    if (!detail || !predicate(detail)) return
    listener(detail)
  }
  window.addEventListener(eventName, onEvent)
  return () => window.removeEventListener(eventName, onEvent)
}

export function subscribeEmbeddedPwaUpdateAvailable(
  listener: (detail: EmbeddedPwaUpdateDetail) => void,
): () => void {
  if (!isEmbeddedPwaOtaSupported()) return () => {}

  const handler = (detail: Record<string, unknown>) => {
    const pendingVer = typeof detail.pendingVer === 'string' ? detail.pendingVer : ''
    if (!pendingVer) return
    listener({
      currentVer: typeof detail.currentVer === 'string' ? detail.currentVer : '',
      pendingVer,
    })
  }

  const predicate = (detail: Record<string, unknown>) =>
    detail.action === 'embeddedPwaUpdateAvailable'

  const offIos = isIosEmbeddedPwaBridgeReady()
    ? subscribeBridgeEvent(IOS_BRIDGE_EVENT, predicate, handler)
    : () => {}
  const offAndroid = isAndroidEmbeddedPwaBridgeReady()
    ? subscribeBridgeEvent(ANDROID_BRIDGE_EVENT, predicate, handler)
    : () => {}

  return () => {
    offIos()
    offAndroid()
  }
}

export function subscribeApplyEmbeddedPwaUpdateResult(
  listener: (detail: ApplyEmbeddedPwaUpdateDetail) => void,
): () => void {
  if (!isEmbeddedPwaOtaSupported()) return () => {}

  const handler = (detail: Record<string, unknown>) => {
    const reason = typeof detail.reason === 'string' ? detail.reason : undefined
    if (reason === NOT_SUPPORTED_REASON) {
      // Shell says OTA is off: no error text, no further calls this session.
      markEmbeddedPwaOtaNotSupported()
    }
    listener({
      ok: detail.ok === true,
      ver: typeof detail.ver === 'string' ? detail.ver : undefined,
      error: typeof detail.error === 'string' ? detail.error : undefined,
      reason,
    })
  }

  const predicate = (detail: Record<string, unknown>) =>
    detail.action === 'applyEmbeddedPwaUpdate'

  const offIos = isIosEmbeddedPwaBridgeReady()
    ? subscribeBridgeEvent(IOS_BRIDGE_EVENT, predicate, handler)
    : () => {}
  const offAndroid = isAndroidEmbeddedPwaBridgeReady()
    ? subscribeBridgeEvent(ANDROID_BRIDGE_EVENT, predicate, handler)
    : () => {}

  return () => {
    offIos()
    offAndroid()
  }
}

/**
 * The chat history of the browser page is published only under a cross-tab lock (Web Locks). Where the browser has none, the history stays on this device, nothing is published and incoming messages are not
 * confirmed as saved: the user is told so, for as long as it is true. A native shell keeps its history itself and shows nothing here.
 */
import { tu } from '@/locale/beamioLocale'
import { isShellContext } from '@/services/shellContext'

/** the same test the history writer uses (vendor chat SDK, browserAccountLock) */
export const historyArchiveSupported = (nav: unknown = typeof navigator === 'undefined' ? undefined : navigator): boolean => !!(nav as { locks?: unknown } | undefined)?.locks

export function HistoryArchiveUnsupportedNotice() {
	if (isShellContext() || historyArchiveSupported()) return null
	return (
		<div role="alert" data-testid="history-archive-unsupported" style={{ padding: '10px 16px', background: '#5b3a00', color: '#ffffff', fontSize: 13, lineHeight: '18px' }}>
			{tu('chat.history_archive_unsupported.body')}
		</div>
	)
}

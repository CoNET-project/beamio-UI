//	index.tsx

// Must stay the first import: takes a legacy Recovery Code out of the URL.
import './utils/legacyRestoreLinkBoot'
import './utils/ignoreResizeObserverLoopError'
import React from 'react';
import ReactDOM from 'react-dom/client';
import './locale/i18n';
import './index.css';
import App from './App';
import { BeamioLocaleRoot } from './locale/BeamioLocaleRoot';
import reportWebVitals from './reportWebVitals';
import { DaemonProvider } from './providers/DaemonProvider'
import { loadApiExcludedUserCards } from './utils/apiExcludedUserCards'
import { MerchantCardDatabaseProvider } from './providers/MerchantCardDatabaseProvider'
import { BeamioTagDatabaseProvider } from './providers/BeamioTagDatabaseProvider'
import { IpfsImageLibraryProvider } from './providers/IpfsImageLibraryProvider'
import { HashRouter as Router } from 'react-router-dom'
import { applyPendingConsumerDeepLinkIfNeeded } from './utils/pendingConsumerDeepLink'
import { installBeamioChatReceiver } from './utils/androidChatChannel'
import { installBeamioShellReceiver } from './utils/beamioShellChannel'
import { installInboundGenerationWatcher } from './services/inboundGeneration'
import { ensureRangTracking } from './utils/incomingRangTracking'
void loadApiExcludedUserCards()
// the Android shell's new chat channel (window.BeamioChat); a no-op without it.
installBeamioChatReceiver()
installBeamioShellReceiver()
//1: the native inbound generation (init success and every advance) is kept from the start.
installInboundGenerationWatcher()
// the first sight of window.BeamioShell records when ring tracking starts; older calls are not asked.
ensureRangTracking()
applyPendingConsumerDeepLinkIfNeeded()

const root = ReactDOM.createRoot(
  	document.getElementById('root') as HTMLElement
)

root.render(
	<React.StrictMode>
		<Router>
			<DaemonProvider>
				<MerchantCardDatabaseProvider>
					<BeamioTagDatabaseProvider>
						<IpfsImageLibraryProvider>
							<BeamioLocaleRoot>
								<App />
							</BeamioLocaleRoot>
						</IpfsImageLibraryProvider>
					</BeamioTagDatabaseProvider>
				</MerchantCardDatabaseProvider>
			</DaemonProvider>
		</Router>
	</React.StrictMode>
)
// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals()


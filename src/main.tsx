import React from 'react';
import ReactDOM from 'react-dom/client';
import { Web3OnboardProvider } from '@web3-onboard/react';
import App from './App';
import { getOnboard } from './wallet/onboard';
import { WalletSessionProvider } from './wallet/WalletSessionContext';

// Wallet initialization happens once, at the app boundary, so `App` itself stays
// free of wallet-library imports.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Web3OnboardProvider web3Onboard={getOnboard()}>
      <WalletSessionProvider>
        <App />
      </WalletSessionProvider>
    </Web3OnboardProvider>
  </React.StrictMode>,
);

'use client';

import '@rainbow-me/rainbowkit/styles.css';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RainbowKitProvider, darkTheme, type Theme } from '@rainbow-me/rainbowkit';
import { config } from '@/lib/chain';

const queryClient = new QueryClient();

// Start from darkTheme to inherit every key, then override the visible surfaces
// with the Coliseum design tokens. Values reference CSS vars (defined on :root
// in coliseum-design.css), so the modal also follows the violet/noir/amber
// palette switcher automatically. Radii are 0 for the sharp CRT-terminal look.
const base = darkTheme();

const coliseumTheme: Theme = {
  ...base,
  colors: {
    ...base.colors,
    accentColor: 'var(--fighter-a)',
    accentColorForeground: '#0a0612',
    modalBackground: 'var(--bg-card)',
    modalBorder: 'var(--border)',
    modalText: 'var(--text)',
    modalTextSecondary: 'var(--text-dim)',
    modalTextDim: 'var(--text-faint)',
    modalBackdrop: 'rgba(5, 3, 10, 0.72)',
    profileForeground: 'var(--bg-stage)',
    profileAction: 'var(--bg-card-2)',
    profileActionHover: 'var(--border)',
    menuItemBackground: 'var(--bg-card-2)',
    actionButtonSecondaryBackground: 'var(--bg-card-2)',
    closeButton: 'var(--text-dim)',
    closeButtonBackground: 'var(--bg-card-2)',
    generalBorder: 'var(--border)',
    generalBorderDim: 'var(--border-soft)',
    selectedOptionBorder: 'var(--fighter-a)',
    connectButtonBackground: 'var(--bg-card)',
    connectButtonInnerBackground: 'var(--bg-card-2)',
    connectButtonText: 'var(--text)',
    error: 'var(--loss)',
  },
  fonts: {
    body: 'var(--fnt-mono), ui-monospace, "SF Mono", Menlo, monospace',
  },
  radii: {
    actionButton: '0px',
    connectButton: '0px',
    menuButton: '0px',
    modal: '0px',
    modalMobile: '0px',
  },
};

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={coliseumTheme} modalSize="compact">
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

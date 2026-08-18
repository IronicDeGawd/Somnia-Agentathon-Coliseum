/**
 * An injected wallet, one per browser context.
 *
 * WHY THIS EXISTS. The site connects through MetaMask or WalletConnect, neither of
 * which a test can drive: one is a browser extension with its own popups, the other
 * wants a phone. So the page is handed a wallet of our own instead. Nothing in the
 * application changes — there is no test-only connector to write, and therefore
 * nothing test-only that could ever ship.
 *
 * THE KEY NEVER ENTERS THE PAGE. The object installed in the browser is a courier:
 * every request is forwarded to Node over an exposed function, and the signing
 * happens there, where the key lives. A page script cannot read it, and neither can
 * anything the page loads.
 *
 * ONE WALLET PER CONTEXT is the point of the whole arrangement. Two contexts are two
 * players who can queue for the same fight and be matched against each other, which
 * is the only way to exercise matchmaking as it actually runs. Transactions from one
 * address are ordered, so two players on one key would queue up behind each other
 * and any burst would collide on the nonce.
 */
import { type BrowserContext } from '@playwright/test';
import {
  createWalletClient, createPublicClient, http, defineChain,
  type Hex, type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const somniaTestnet = defineChain({
  id: 50312,
  name: 'Somnia Shannon Testnet',
  nativeCurrency: { name: 'Somnia Token', symbol: 'STT', decimals: 18 },
  rpcUrls: { default: { http: ['https://dream-rpc.somnia.network'] } },
  testnet: true,
});

/** 50312 as the hex string a wallet is expected to report. */
const CHAIN_ID_HEX = '0xc488';

export interface InjectedWallet {
  address: Address;
  /** Everything the page asked for, in order — useful when a flow stalls. */
  calls: string[];
}

/**
 * Install a wallet into every page of `context`, backed by `privateKey`.
 *
 * Must be called before the first navigation: the application discovers wallets
 * when its config is built, which happens as the first script runs.
 */
export async function installWallet(
  context: BrowserContext,
  privateKey: Hex,
  label = 'Test Wallet',
): Promise<InjectedWallet> {
  const account = privateKeyToAccount(privateKey);
  const transport = http(somniaTestnet.rpcUrls.default.http[0]);
  const wallet = createWalletClient({ account, chain: somniaTestnet, transport });
  const pub = createPublicClient({ chain: somniaTestnet, transport });

  const state: InjectedWallet = { address: account.address, calls: [] };

  // The Node half. Anything not a signing request is passed through to the RPC, so
  // the page sees an ordinary wallet rather than one with holes in it.
  await context.exposeFunction(
    '__coliseumWalletRequest',
    async (method: string, params: unknown[]): Promise<unknown> => {
      state.calls.push(method);
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return [account.address];
        case 'eth_chainId':
          return CHAIN_ID_HEX;
        case 'net_version':
          return String(somniaTestnet.id);
        // Already on the right chain, so both are a no-op rather than an error —
        // a wallet that refuses these makes the site show its wrong-network state.
        case 'wallet_switchEthereumChain':
        case 'wallet_addEthereumChain':
          return null;
        case 'eth_sendTransaction': {
          const tx = params[0] as {
            to?: Address; data?: Hex; value?: Hex; gas?: Hex; from?: Address;
          };
          return wallet.sendTransaction({
            to: tx.to,
            data: tx.data,
            value: tx.value ? BigInt(tx.value) : undefined,
            gas: tx.gas ? BigInt(tx.gas) : undefined,
          });
        }
        case 'personal_sign':
          // personal_sign puts the message first; eth_sign puts the address first.
          return wallet.signMessage({ message: { raw: params[0] as Hex } });
        case 'eth_sign':
          return wallet.signMessage({ message: { raw: params[1] as Hex } });
        case 'eth_signTypedData_v4':
          return wallet.signTypedData(JSON.parse(params[1] as string));
        default:
          return pub.request({ method: method as never, params: params as never });
      }
    },
  );

  // The page half. A courier with an event emitter, announced the way a real wallet
  // announces itself so the application's ordinary discovery finds it.
  await context.addInitScript(
    ({ address, chainIdHex, name }) => {
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
      const provider = {
        isMetaMask: false,
        // Some libraries branch on this before they will attempt a connection.
        isConnected: () => true,
        request: async ({ method, params }: { method: string; params?: unknown[] }) =>
          (window as unknown as {
            __coliseumWalletRequest: (m: string, p: unknown[]) => Promise<unknown>;
          }).__coliseumWalletRequest(method, params ?? []),
        on(event: string, handler: (...args: unknown[]) => void) {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)!.add(handler);
          return provider;
        },
        removeListener(event: string, handler: (...args: unknown[]) => void) {
          listeners.get(event)?.delete(handler);
          return provider;
        },
      };

      (window as unknown as { ethereum: unknown }).ethereum = provider;

      const info = {
        uuid: '11111111-2222-3333-4444-555555555555',
        name,
        // A one-pixel transparent PNG. The field is required, and an icon that
        // fails to load takes the wallet out of some pickers entirely.
        icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
        rdns: 'network.somnia.coliseum.test',
      };
      const announce = () =>
        window.dispatchEvent(
          new CustomEvent('eip6963:announceProvider', {
            detail: Object.freeze({ info, provider }),
          }),
        );
      // Announce once now and again on request: whichever side starts first, the
      // other still hears it.
      window.addEventListener('eip6963:requestProvider', announce);
      announce();

      // Report the chain immediately as well, since a wallet that only answers when
      // asked leaves the site briefly showing a wrong-network warning.
      void chainIdHex;
      void address;
    },
    { address: account.address, chainIdHex: CHAIN_ID_HEX, name: label },
  );

  return state;
}

import { createDAppKit } from '@mysten/dapp-kit-core';
import { SuiGrpcClient } from '@mysten/sui/grpc';

const MAINNET_GRPC_URL = 'https://fullnode.mainnet.sui.io:443';
const LAST_WALLET_KEY = 'the-archive:last-wallet';

const walletDefinitions = [
  {
    key: 'slush',
    label: 'Slush',
    mark: 'SL',
    matches: ['slush'],
    downloadUrl: 'https://slush.app/',
  },
  {
    key: 'phantom',
    label: 'Phantom',
    mark: 'PH',
    matches: ['phantom'],
    downloadUrl: 'https://phantom.com/download',
  },
  {
    key: 'binance',
    label: 'Binance Wallet',
    mark: 'BN',
    matches: ['binance'],
    downloadUrl: 'https://www.binance.com/en/web3wallet',
  },
  {
    key: 'okx',
    label: 'OKX Wallet',
    mark: 'OK',
    matches: ['okx'],
    downloadUrl: 'https://web3.okx.com/download',
  },
];

export const dAppKit = createDAppKit({
  networks: ['mainnet'],
  defaultNetwork: 'mainnet',
  createClient: (network) =>
    new SuiGrpcClient({ network, baseUrl: MAINNET_GRPC_URL }),
  autoConnect: true,
  storageKey: 'the-archive:selected-wallet-and-address',
  slushWalletConfig: {
    appName: 'The Archive',
  },
});

const walletButton = document.getElementById('walletBtn');
const wizardWalletButton = document.getElementById('wizardWalletBtn');
const walletDialog = document.getElementById('walletDialog');
const walletCloseButton = document.getElementById('walletCloseBtn');
const walletStatus = document.getElementById('walletStatus');
const walletDisconnectButton = document.getElementById('walletDisconnectBtn');
const walletOptionButtons = [...document.querySelectorAll('[data-wallet-key]')];

let phantomSession = null;
let pendingWizardAdvance = false;
let lastFocusedElement = null;
let connectingWalletKey = null;

function getPhantomProvider() {
  const provider = window.phantom?.sui;
  return provider?.isPhantom ? provider : null;
}

function normalizedWalletIdentity(wallet) {
  return `${wallet?.id ?? ''} ${wallet?.name ?? ''}`.toLowerCase();
}

function findStandardWallet(definition) {
  return dAppKit.stores.$wallets
    .get()
    .find((wallet) =>
      definition.matches.some((match) => normalizedWalletIdentity(wallet).includes(match)),
    );
}

function getWalletAdapter(definition) {
  if (definition.key === 'phantom') {
    const provider = getPhantomProvider();
    if (provider) return { type: 'phantom', provider };
  }

  const wallet = findStandardWallet(definition);
  return wallet ? { type: 'standard', wallet } : null;
}

function definitionForWallet(wallet) {
  const identity = normalizedWalletIdentity(wallet);
  return walletDefinitions.find((definition) =>
    definition.matches.some((match) => identity.includes(match)),
  );
}

function standardConnection() {
  return dAppKit.stores.$connection.get();
}

function activeConnection() {
  const connection = standardConnection();
  if (connection.isConnected && connection.account) {
    return {
      type: 'standard',
      wallet: connection.wallet,
      walletName: connection.wallet?.name ?? 'Sui Wallet',
      address: connection.account.address,
    };
  }
  return phantomSession;
}

function shortAddress(address) {
  if (!address || address.length < 13) return address || 'Connected';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function safeWalletIcon(icon) {
  if (typeof icon !== 'string') return null;
  return icon.startsWith('data:image/') || icon.startsWith('https://') ? icon : null;
}

function renderWalletMark(button, definition, wallet) {
  const mark = button.querySelector('[data-wallet-mark]');
  const icon = safeWalletIcon(wallet?.icon);
  mark.replaceChildren();

  if (icon) {
    const image = document.createElement('img');
    image.src = icon;
    image.alt = '';
    mark.append(image);
  } else {
    mark.textContent = definition.mark;
  }
}

function renderWalletOptions() {
  const current = activeConnection();
  let detectedCount = 0;

  for (const button of walletOptionButtons) {
    const definition = walletDefinitions.find(
      (candidate) => candidate.key === button.dataset.walletKey,
    );
    const adapter = getWalletAdapter(definition);
    const state = button.querySelector('.wallet-option-state');
    const standardWallet = adapter?.type === 'standard' ? adapter.wallet : null;
    const isCurrent =
      (current?.type === 'phantom' && definition.key === 'phantom') ||
      (current?.type === 'standard' &&
        definition.matches.some((match) =>
          normalizedWalletIdentity(current.wallet).includes(match),
        ));

    if (adapter) detectedCount += 1;
    button.classList.toggle('detected', Boolean(adapter));
    button.disabled = Boolean(connectingWalletKey);
    button.setAttribute('aria-busy', String(connectingWalletKey === definition.key));
    state.textContent = isCurrent
      ? 'CONNECTED'
      : connectingWalletKey === definition.key
        ? 'CONNECTING'
        : adapter
          ? 'READY'
          : 'INSTALL';
    renderWalletMark(button, definition, standardWallet);
  }

  if (!current && !connectingWalletKey) {
    walletStatus.textContent = detectedCount
      ? `${detectedCount} compatible wallet${detectedCount === 1 ? '' : 's'} detected.`
      : 'No compatible wallet detected. Choose one to install it.';
  }
}

function renderConnectionState() {
  const connection = standardConnection();
  const current = activeConnection();
  const reconnecting = connection.isReconnecting;

  if (current) {
    walletButton.textContent = shortAddress(current.address);
    walletButton.title = `${current.walletName} · ${current.address}`;
    walletButton.setAttribute('aria-label', `Wallet connected: ${current.walletName}`);
    walletDisconnectButton.hidden = false;
    walletStatus.textContent = `${current.walletName} connected on Sui Mainnet · ${shortAddress(current.address)}`;
  } else {
    walletButton.textContent = reconnecting ? 'Reconnecting…' : 'Connect Wallet';
    walletButton.title = '';
    walletButton.setAttribute('aria-label', 'Connect Sui wallet');
    walletDisconnectButton.hidden = true;
  }

  walletButton.setAttribute('aria-busy', String(connection.isConnecting || reconnecting));
  renderWalletOptions();
}

function showToast(message) {
  if (typeof window.showToast === 'function') window.showToast(message);
}

function openWalletDialog({ fromWizard = false } = {}) {
  pendingWizardAdvance = fromWizard;
  lastFocusedElement = document.activeElement;
  walletDialog.hidden = false;
  document.body.classList.add('wallet-open');
  renderConnectionState();
  walletCloseButton.focus();
}

function closeWalletDialog({ cancelWizard = true } = {}) {
  walletDialog.hidden = true;
  document.body.classList.remove('wallet-open');
  if (cancelWizard) pendingWizardAdvance = false;
  if (lastFocusedElement instanceof HTMLElement) lastFocusedElement.focus();
}

function setLastWallet(value) {
  try {
    if (value) localStorage.setItem(LAST_WALLET_KEY, value);
    else localStorage.removeItem(LAST_WALLET_KEY);
  } catch {
    // Wallet connection must still work when browser storage is unavailable.
  }
}

function finishConnection(definition) {
  setLastWallet(definition.key);
  showToast(`${definition.label} connected`);
  const shouldAdvance = pendingWizardAdvance;
  pendingWizardAdvance = false;
  closeWalletDialog({ cancelWizard: false });
  if (shouldAdvance && typeof window.nextStep === 'function') window.nextStep();
}

function phantomAddress(response) {
  const value = response?.address ?? response?.publicKey;
  if (typeof value === 'string') return value;
  if (value && typeof value.toString === 'function') return value.toString();
  throw new Error('Phantom did not return a Sui account');
}

async function connectWallet(definition) {
  const adapter = getWalletAdapter(definition);
  const current = activeConnection();

  if (
    (current?.type === 'phantom' && definition.key === 'phantom') ||
    (current?.type === 'standard' &&
      definition.matches.some((match) =>
        normalizedWalletIdentity(current.wallet).includes(match),
      ))
  ) {
    closeWalletDialog();
    return;
  }

  if (!adapter) {
    window.open(definition.downloadUrl, '_blank', 'noopener,noreferrer');
    showToast(`${definition.label} is not installed`);
    return;
  }

  connectingWalletKey = definition.key;
  walletStatus.textContent = `Waiting for ${definition.label} approval…`;
  renderWalletOptions();

  try {
    const existingStandardConnection = standardConnection();
    if (existingStandardConnection.isConnected) await dAppKit.disconnectWallet();
    phantomSession = null;

    if (adapter.type === 'phantom') {
      const account = await adapter.provider.requestAccount();
      phantomSession = {
        type: 'phantom',
        walletName: definition.label,
        address: phantomAddress(account),
        provider: adapter.provider,
      };
    } else {
      await dAppKit.connectWallet({ wallet: adapter.wallet });
    }

    finishConnection(definition);
  } catch (error) {
    pendingWizardAdvance = false;
    const message = String(error?.message ?? error).toLowerCase();
    const cancelled =
      error?.code === 4001 || message.includes('reject') || message.includes('cancel');
    walletStatus.textContent = cancelled
      ? `${definition.label} connection was cancelled.`
      : `${definition.label} could not connect. Check that Sui Mainnet is enabled.`;
    showToast(cancelled ? 'Wallet connection cancelled' : 'Wallet connection failed');
  } finally {
    connectingWalletKey = null;
    renderConnectionState();
  }
}

async function disconnectCurrentWallet() {
  try {
    if (standardConnection().isConnected) await dAppKit.disconnectWallet();
  } finally {
    phantomSession = null;
    setLastWallet(null);
    renderConnectionState();
    showToast('Wallet disconnected');
  }
}

walletButton.addEventListener('click', () => openWalletDialog());
wizardWalletButton.addEventListener('click', () => {
  if (activeConnection()) {
    window.nextStep();
  } else {
    openWalletDialog({ fromWizard: true });
  }
});
walletCloseButton.addEventListener('click', () => closeWalletDialog());
walletDialog.querySelector('[data-wallet-close]').addEventListener('click', () =>
  closeWalletDialog(),
);
walletDisconnectButton.addEventListener('click', disconnectCurrentWallet);

for (const button of walletOptionButtons) {
  button.addEventListener('click', () => {
    const definition = walletDefinitions.find(
      (candidate) => candidate.key === button.dataset.walletKey,
    );
    connectWallet(definition);
  });
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !walletDialog.hidden) closeWalletDialog();
});

dAppKit.stores.$wallets.subscribe(renderWalletOptions);
dAppKit.stores.$connection.subscribe((connection) => {
  if (connection.isConnected && connection.wallet) {
    const definition = definitionForWallet(connection.wallet);
    if (definition) setLastWallet(definition.key);
  }
  renderConnectionState();
});

window.addEventListener('wallet-standard:register-wallet', renderWalletOptions);
window.addEventListener('load', () => {
  renderConnectionState();
});

window.theArchiveWallet = {
  dAppKit,
  getConnection: activeConnection,
};

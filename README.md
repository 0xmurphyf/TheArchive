# The Archive

The Archive is a Sui Mainnet display frontend for preserving the story of an
on-chain object after ownership ends.

## Wallet support

- Slush through the Sui dApp Kit web wallet and Wallet Standard
- OKX Wallet through Wallet Standard
- Binance Wallet through Wallet Standard when its Sui provider is registered
- Phantom through its official injected Sui provider

Compatible wallets are detected in the browser. Sui dApp Kit automatically
restores the last Wallet Standard connection. Phantom requires a secure origin
(`https`, `localhost`, or `127.0.0.1`) before it injects its Sui provider.

The current archive transaction flow is still a prototype and does not submit
a real Sui transaction.

## Local development

Requirements: Node.js 22.12 or newer and pnpm 11.

```bash
pnpm install
pnpm dev
```

Create a production build with:

```bash
pnpm build
```

## Railway

Railway detects the Vite project, runs the build script, and serves the `dist`
directory as a static site. Connect this GitHub repository to Railway and use
the default build settings.

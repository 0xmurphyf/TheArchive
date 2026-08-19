# The Archive server

This Node service keeps a durable cache of the deployed Testnet package's
`MemoryArchived` events. It listens over Sui gRPC, reconciles through GraphQL,
stores complete archive objects in SQLite, exposes JSON and SSE APIs, and serves
the repository's `dist/` website from the same process.

## Run

Requires Node 22.12 or newer.

```sh
pnpm --dir server install --ignore-workspace
pnpm --dir server start
```

On Railway, persist `server/data` with a volume and use
`pnpm --dir server start` as the start command. Build the frontend before the
service starts so that `dist/index.html` exists.

**Railway volume (required for durability):** Railway does NOT honor the
`VOLUME` directive in the Dockerfile. You must create a Railway Volume in the
project dashboard and mount it at `/app/server/data`. If you skip this, the
SQLite archive cache (`archive.sqlite`), uploaded Original Images (`uploads/`),
and visitor comments are stored on the container's ephemeral filesystem and are
**lost on every rebuild / deploy**. The Dockerfile only declares the volume so
the mount point exists; the actual persistence comes from the Railway Volume.

Configuration is documented in `.env.example`. The default network is Sui
Testnet and the default reconciliation interval is one hour.

## API

- `GET /api/archives` — cached archives and cache metadata
- `GET /api/health` — cache and listener health
- `GET /api/archives/stream` — SSE; new records use event name `archive`
- `GET /api/owned-objects?address=0x...` — merged NFT/Kiosk ownership from the configured indexer
- `GET /api/comments?archiveId=0x...` — visitor notes for an archive (newest first, max 100)
- `POST /api/comments?archiveId=0x...` — add a visitor note (`{ "text": "..." }`, max 120 chars)
- `POST /api/uploads` — Original Image upload (image only), served from `/media/...`

Owned-object indexer configuration:

- `OWNED_OBJECTS_INDEXER_ENDPOINT` — defaults to TradePort's read-only GraphQL endpoint
- `OWNED_OBJECTS_INDEXER_API_USER` / `OWNED_OBJECTS_INDEXER_API_KEY` — optional overrides for deployments
- `OWNED_OBJECTS_INDEXER_TIMEOUT_MS` — request timeout, default 15000
- `OWNED_OBJECTS_INDEXER_PAGE_SIZE` — NFT page size, default 100

Run the isolated tests with `pnpm --dir server test`.

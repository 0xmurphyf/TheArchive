import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PACKAGE_ID =
  '0x438eab12b59b366c113c54e864c34232c4514002043081747aff7a0de6c293f0';

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env = process.env) {
  const serverDir = fileURLToPath(new URL('.', import.meta.url));
  const rootDir = resolve(serverDir, '..');
  const packageId = (env.SUI_PACKAGE_ID || DEFAULT_PACKAGE_ID).toLowerCase();

  return {
    host: env.HOST || '0.0.0.0',
    port: positiveInteger(env.PORT, 3000),
    corsOrigin: env.CORS_ORIGIN || '*',
    databasePath: resolve(rootDir, env.ARCHIVE_DATABASE_PATH || 'server/data/archive.sqlite'),
    staticDir: resolve(rootDir, env.STATIC_DIR || 'dist'),
    uploadsDir: resolve(rootDir, env.UPLOADS_DIR || 'server/data/uploads'),
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    maxUploadBytes: positiveInteger(env.MAX_UPLOAD_BYTES, 10 * 1024 * 1024),
    packageId,
    eventType:
      env.SUI_ARCHIVE_EVENT_TYPE || `${packageId}::memory_archive::MemoryArchived`,
    graphqlUrl: env.SUI_GRAPHQL_URL || 'https://graphql.mainnet.sui.io/graphql',
    grpcUrl: env.SUI_GRPC_URL || 'https://fullnode.mainnet.sui.io:443',
    reconcileIntervalMs: positiveInteger(env.RECONCILE_INTERVAL_MS, 60 * 60 * 1000),
    graphqlTimeoutMs: positiveInteger(env.GRAPHQL_TIMEOUT_MS, 15_000),
    objectRetryCount: positiveInteger(env.OBJECT_RETRY_COUNT, 8),
    objectRetryBaseMs: positiveInteger(env.OBJECT_RETRY_BASE_MS, 750),
    reconnectBaseMs: positiveInteger(env.GRPC_RECONNECT_BASE_MS, 1_000),
    reconnectMaxMs: positiveInteger(env.GRPC_RECONNECT_MAX_MS, 30_000),
    maxSseClients: positiveInteger(env.MAX_SSE_CLIENTS, 250),
    ownedObjectsIndexerEndpoint: env.OWNED_OBJECTS_INDEXER_ENDPOINT || 'https://graphql.tradeport.gg/',
    ownedObjectsIndexerApiUser: env.OWNED_OBJECTS_INDEXER_API_USER || 'tradeport.xyz',
    ownedObjectsIndexerApiKey: env.OWNED_OBJECTS_INDEXER_API_KEY || '7cJ09MM.9c8d37fc6e5fad1cf0823c68657cabdd',
    ownedObjectsIndexerTimeoutMs: positiveInteger(env.OWNED_OBJECTS_INDEXER_TIMEOUT_MS, 15_000),
    ownedObjectsIndexerPageSize: positiveInteger(env.OWNED_OBJECTS_INDEXER_PAGE_SIZE, 100),
  };
}

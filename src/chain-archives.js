export const PACKAGE_ID = '0x438eab12b59b366c113c54e864c34232c4514002043081747aff7a0de6c293f0';
export const EVENT_TYPE = `${PACKAGE_ID}::memory_archive::MemoryArchived`;
export const GRAPHQL_ENDPOINT = 'https://graphql.mainnet.sui.io/graphql';
const configuredArchiveApiUrl = import.meta.env?.VITE_ARCHIVE_API_URL?.trim();
export const ARCHIVE_API_URL = configuredArchiveApiUrl || '/api/archives';
export const ARCHIVE_STREAM_URL = `${ARCHIVE_API_URL.replace(/\/+$/, '')}/stream`;

const STATIC_CACHE_URL = '/archive-cache.json';
const CACHE_REQUEST_TIMEOUT_MS = 3_000;

const EVENTS_QUERY = `
  query ArchiveEvents($cursor: String, $eventType: String!) {
    events(first: 50, after: $cursor, filter: { type: $eventType }) {
      nodes {
        contents { json }
        timestamp
        transaction { digest }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const OBJECT_QUERY = `
  query ArchiveObject($address: SuiAddress!) {
    object(address: $address) {
      address
      version
      digest
      asMoveObject {
        contents { json type { repr } }
      }
    }
  }
`;

async function graphql(query, variables) {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`Mainnet index returned HTTP ${response.status}`);
  const body = await response.json();
  if (body.errors?.length) throw new Error(body.errors[0].message || 'Mainnet index query failed');
  return body.data;
}

function archivesFromPayload(payload) {
  const archives = Array.isArray(payload)
    ? payload
    : payload?.archives || payload?.data?.archives || payload?.data;

  if (!Array.isArray(archives)) {
    throw new Error('Archive cache returned an invalid payload');
  }

  return archives.sort((a, b) => Number(b.archivedAtMs || 0) - Number(a.archivedAtMs || 0));
}

async function fetchArchiveCache(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CACHE_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Archive cache returned HTTP ${response.status}`);

    const payload = await response.json();
    return {
      archives: archivesFromPayload(payload),
      generatedAt: payload?.generatedAt || payload?.updatedAt || '',
      source: url === ARCHIVE_API_URL ? 'api' : 'static',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadCachedArchives() {
  const errors = [];

  for (const url of [ARCHIVE_API_URL, STATIC_CACHE_URL]) {
    try {
      return await fetchArchiveCache(url);
    } catch (error) {
      errors.push(error);
    }
  }

  throw new AggregateError(errors, 'No archive cache is available');
}

function valueOf(object, ...names) {
  for (const name of names) {
    if (object?.[name] !== undefined && object?.[name] !== null) return object[name];
  }
  return '';
}

function parseEvent(event) {
  const eventJson = event.contents?.json;
  const raw = typeof eventJson === 'string' ? JSON.parse(eventJson) : eventJson;
  return {
    archiveId: valueOf(raw, 'archive_id', 'archiveId'),
    originalObjectId: valueOf(raw, 'original_object_id', 'originalObjectId'),
    artifactId: valueOf(raw, 'artifact_id', 'artifactId'),
    archivedBy: valueOf(raw, 'archived_by', 'archivedBy'),
    archivedAtMs: Number(valueOf(raw, 'archived_at_ms', 'archivedAtMs') || event.timestamp || 0),
    sourceType: Number(valueOf(raw, 'source_type', 'sourceType') || 0),
    storageType: Number(valueOf(raw, 'storage_type', 'storageType') || 0),
    transactionDigest: event.transaction?.digest || '',
  };
}

async function enrichArchive(event) {
  const data = await graphql(OBJECT_QUERY, { address: event.archiveId });
  const object = data.object;
  const contents = object?.asMoveObject?.contents?.json || {};
  const objectType = object?.asMoveObject?.contents?.type?.repr || '';
  return {
    ...event,
    objectVersion: object?.version || '',
    objectDigest: object?.digest || '',
    content: { ...contents, artifact_type: objectType },
  };
}

export async function scanArchives() {
  const events = [];
  let cursor = null;
  do {
    const data = await graphql(EVENTS_QUERY, { cursor, eventType: EVENT_TYPE });
    events.push(...data.events.nodes.map(parseEvent));
    cursor = data.events.pageInfo.hasNextPage ? data.events.pageInfo.endCursor : null;
  } while (cursor);

  const archives = await Promise.all(events.map(enrichArchive));
  return archives.sort((a, b) => b.archivedAtMs - a.archivedAtMs);
}

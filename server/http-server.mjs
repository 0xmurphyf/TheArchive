import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function serialize(value) {
  return JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
}

function allowedOrigin(requestOrigin, configured) {
  if (configured === '*') return '*';
  const origins = configured
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return requestOrigin && origins.includes(requestOrigin) ? requestOrigin : null;
}

function applyCors(req, res, corsOrigin) {
  const origin = allowedOrigin(req.headers.origin, corsOrigin);
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  if (origin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID, X-Image-Name');
}

function json(res, status, body) {
  const payload = serialize(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function existingFile(path) {
  try {
    const info = await stat(path);
    return info.isFile() ? path : null;
  } catch {
    return null;
  }
}

function resolveImageTarget(target) {
  const raw = String(target || '').trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^ipfs:\/\//i.test(raw)) {
    const parsed = new URL(raw);
    const path = `${parsed.hostname}${parsed.pathname}`.replace(/^\/+/, '');
    const gateway = process.env.IPFS_GATEWAY_URL || 'https://ipfs.io/ipfs/';
    return `${gateway.replace(/\/+$/, '')}/${path}${parsed.search}`;
  }
  if (/^walrus:\/\//i.test(raw) || /^walrus:/i.test(raw)) {
    const parsed = new URL(raw);
    const blobId = `${parsed.hostname}${parsed.pathname}`.replace(/^\/+/, '');
    const aggregator = process.env.WALRUS_AGGREGATOR_URL || 'https://aggregator.walrus.space/v1/blobs';
    return `${aggregator.replace(/\/+$/, '')}/${blobId}${parsed.search}`;
  }
  throw new Error('Only http(s), ipfs://, and walrus:// image URLs are supported');
}

async function hashRemoteImage(target, signal, maxBytes) {
  const resolvedTarget=resolveImageTarget(target);
  let parsed;
  try { parsed = new URL(resolvedTarget); } catch { throw new Error('Image URL is invalid'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Image gateway URL is invalid');
  if (/^(localhost|127\.|0\.0\.0\.0$|::1$)/i.test(parsed.hostname)) throw new Error('Private image hosts are not allowed');
  const response = await fetch(parsed, { signal, redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Image fetch failed with HTTP ${response.status}`);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`Image exceeds ${maxBytes} bytes`);
    hash.update(chunk);
  }
  return { hash: Array.from(hash.digest()), bytes: size, contentType: response.headers.get('content-type') || '' };
}

async function serveStatic(req, res, staticDir, pathname) {
  let requested;
  try {
    requested = decodeURIComponent(pathname);
  } catch {
    json(res, 400, { error: 'Invalid URL' });
    return;
  }

  const root = resolve(staticDir);
  const relative = requested === '/' ? 'index.html' : `.${requested}`;
  const candidate = resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    json(res, 403, { error: 'Forbidden' });
    return;
  }

  const file = (await existingFile(candidate)) || (await existingFile(join(root, 'index.html')));
  if (!file) {
    json(res, 404, { error: 'Website build not found' });
    return;
  }

  const info = await stat(file);
  const headers = {
    'Content-Type': CONTENT_TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': file.endsWith('index.html')
      ? 'no-cache'
      : 'public, max-age=3600',
  };
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
}

export function createArchiveHttpServer({
  store,
  events,
  packageId,
  eventType,
  staticDir,
  corsOrigin = '*',
  maxSseClients = 250,
  health = () => ({}),
  uploadsDir = '',
  publicBaseUrl = '',
  maxUploadBytes = 10 * 1024 * 1024,
  ownedObjectIndexer = null,
}) {
  let activeStreams = 0;

  return createServer(async (req, res) => {
    applyCors(req, res, corsOrigin);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/api/image-hash' && req.method === 'GET') {
      const target = url.searchParams.get('url') || '';
      try {
        json(res, 200, await hashRemoteImage(target, req.signal, maxUploadBytes));
      } catch (error) {
        json(res, 502, { error: String(error?.message || error) });
      }
      return;
    }
    if (url.pathname === '/api/uploads' && req.method === 'POST') {
      const contentType = String(req.headers['content-type'] || '').toLowerCase();
      const contentLength = Number(req.headers['content-length'] || 0);
      if (!contentType.startsWith('image/')) {
        json(res, 415, { error: 'Only image uploads are accepted' });
        return;
      }
      if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > maxUploadBytes) {
        json(res, 413, { error: `Image must be between 1 byte and ${maxUploadBytes} bytes` });
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxUploadBytes) {
          json(res, 413, { error: `Image exceeds ${maxUploadBytes} bytes` });
          return;
        }
        chunks.push(chunk);
      }
      if (!uploadsDir) {
        json(res, 503, { error: 'Image upload storage is not configured' });
        return;
      }
      const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg' })[contentType] || 'bin';
      const filename = `${randomUUID()}.${extension}`;
      await mkdir(uploadsDir, { recursive: true });
      await writeFile(join(uploadsDir, filename), Buffer.concat(chunks), { flag: 'wx' });
      const base = publicBaseUrl || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
      json(res, 201, { url: `${base}/media/${filename}`, bytes: size, contentType });
      return;
    }
    if (url.pathname === '/api/comments' && store) {
      const archiveId = (url.searchParams.get('archiveId') || '').trim();
      if (!archiveId) {
        json(res, 400, { error: 'archiveId is required' });
        return;
      }
      if (req.method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit') || 50) || 50, 100);
        const comments = store.listComments(archiveId, limit);
        json(res, 200, { archiveId, comments });
        return;
      }
      if (req.method === 'POST') {
        const chunks = [];
        let size = 0;
        const maxBytes = 16 * 1024; // generous for a 120-char note + metadata
        try {
          for await (const chunk of req) {
            size += chunk.length;
            if (size > maxBytes) {
              json(res, 413, { error: 'Comment too large' });
              return;
            }
            chunks.push(chunk);
          }
        } catch {
          json(res, 400, { error: 'Unable to read request body' });
          return;
        }
        let payload;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          json(res, 400, { error: 'Invalid JSON body' });
          return;
        }
        const text = String(payload?.text || '').trim();
        if (!text) {
          json(res, 400, { error: 'Comment text is required' });
          return;
        }
        if (text.length > 120) {
          json(res, 400, { error: 'Comment must be 120 characters or fewer' });
          return;
        }
        try {
          const saved = store.insertComment({ archiveId, text });
          json(res, 201, saved);
        } catch (error) {
          json(res, 500, { error: String(error?.message || error) });
        }
        return;
      }
      json(res, 405, { error: 'Method not allowed' });
      return;
    }
    if (url.pathname.startsWith('/media/')) {
      const filename = url.pathname.slice('/media/'.length);
      if (!/^[0-9a-f-]+\.(jpg|png|webp|gif|avif|svg|bin)$/.test(filename) || !uploadsDir) {
        json(res, 404, { error: 'Image not found' });
        return;
      }
      await serveStatic(req, res, uploadsDir, `/${filename}`);
      return;
    }
    if (url.pathname.startsWith('/api/') && req.method !== 'GET') {
      json(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (url.pathname === '/api/owned-objects') {
      if (!ownedObjectIndexer) {
        json(res, 503, { error: 'Owned-object indexer is not configured' });
        return;
      }
      const address = url.searchParams.get('address') || '';
      try {
        const result = await ownedObjectIndexer(address, { signal: req.signal });
        json(res, 200, result);
      } catch (error) {
        json(res, 502, { error: String(error?.message || error) });
      }
      return;
    }

    if (url.pathname === '/api/archives') {
      json(res, 200, {
        archives: store.listArchives(),
        generatedAt: store.getMeta('generatedAt'),
        packageId,
        eventType,
      });
      return;
    }

    if (url.pathname === '/api/health') {
      const archiveCount = store.countArchives();
      const generatedAt = store.getMeta('generatedAt');
      const details = health();
      const cacheReady = Boolean(generatedAt) || archiveCount > 0;
      const listenerConnected = Boolean(details.listener?.connected);
      const operational = cacheReady || listenerConnected;
      json(res, operational ? 200 : 503, {
        status: cacheReady && listenerConnected ? 'ok' : operational ? 'degraded' : 'starting',
        archiveCount,
        generatedAt,
        activeStreams,
        ...details,
      });
      return;
    }

    if (url.pathname === '/api/archives/stream') {
      if (activeStreams >= maxSseClients) {
        res.setHeader('Retry-After', '30');
        json(res, 503, { error: 'Archive stream is at capacity' });
        return;
      }
      activeStreams += 1;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      let closed = false;
      let unsubscribe = () => {};
      let heartbeat;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        activeStreams -= 1;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
      };
      const write = (payload) => {
        if (closed) return;
        try {
          if (!res.write(payload)) {
            cleanup();
            res.end();
          }
        } catch {
          cleanup();
        }
      };
      write(`event: ready\ndata: ${serialize({ generatedAt: store.getMeta('generatedAt') })}\n\n`);
      unsubscribe = events.subscribe((archive) => {
        write(`event: archive\ndata: ${serialize(archive)}\n\n`);
      });
      if (closed) {
        unsubscribe();
        return;
      }
      heartbeat = setInterval(() => write(': keep-alive\n\n'), 20_000);
      heartbeat.unref();
      req.on('close', cleanup);
      res.on('error', cleanup);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      json(res, 404, { error: 'Not found' });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(res, 405, { error: 'Method not allowed' });
      return;
    }
    await serveStatic(req, res, staticDir, url.pathname);
  });
}

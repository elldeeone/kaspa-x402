import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { JsonPnnRpc, trustedNodeUrl } from '@kaspa-x402/adapters';
import { createNodeBoundedPnnWebSocket } from '@kaspa-x402/adapters/pnn-node';

const MAX_BYTES = 4_259_840;
const METHODS = new Set(['getServerInfo', 'getUtxosByAddresses', 'getBlockDagInfo',
  'getBlock', 'getVirtualChainFromBlock', 'getVirtualChainFromBlockV2', 'submitTransaction']);

/** Private transport only: no keys, grants, payment state or application routes. */
export async function startDemoPnnRelay({ endpoints, token, host = '127.0.0.1', port = 0,
  allowInsecureLoopback = false, timeoutMs = 15_000, maxConcurrency = 32 }) {
  if (typeof token !== 'string' || Buffer.byteLength(token) < 32) throw Error('Relay token requires at least 32 bytes');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000 ||
      !Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 64) throw Error('Invalid relay limits');
  const allowed = new Set(endpoints.map(e => trustedNodeUrl(e, 'pnn', allowInsecureLoopback).href));
  if (!allowed.size) throw Error('Explicit PNN endpoints are required');
  const expected = Buffer.from(`Bearer ${token}`);
  let active = 0;
  const sessions = new Map();
  const drop = sessionId => {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    sessions.delete(sessionId); clearTimeout(entry.timer);
    void entry.rpc.disconnect(); entry.socket?.terminate();
  };
  const touch = (sessionId, entry) => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => drop(sessionId), 2 * timeoutMs);
  };
  const server = createServer(async (req, res) => {
    const answer = (status, body) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(body);
    };
    const given = Buffer.from(req.headers.authorization ?? '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      res.shouldKeepAlive = false; answer(401, '{}'); return;
    }
    if (req.url !== '/rpc' || req.method !== 'POST') { answer(404, '{}'); return; }
    if (active >= maxConcurrency) { res.shouldKeepAlive = false; answer(503, '{}'); return; }
    active++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnected);
    let sessionId;
    const abortBody = () => { if (sessionId) drop(sessionId); if (!req.complete) req.destroy(); };
    controller.signal.addEventListener('abort', abortBody);
    try {
      const parts = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BYTES) { res.shouldKeepAlive = false; answer(413, '{}'); return; }
        parts.push(chunk);
      }
      let payload;
      try { payload = JSON.parse(Buffer.concat(parts, size).toString('utf8')); }
      catch { answer(400, '{}'); return; }
      if (!payload || !allowed.has(payload.endpoint) ||
          !/^[0-9a-f-]{36}$/.test(payload.sessionId ?? '') ||
          ![...METHODS, 'connect', 'disconnect'].includes(payload.method) ||
          !payload.params || typeof payload.params !== 'object' || Array.isArray(payload.params)) {
        answer(400, '{}'); return;
      }
      sessionId = payload.sessionId;
      controller.signal.throwIfAborted();
      if (payload.method === 'disconnect') { drop(sessionId); answer(200, '{}'); return; }
      let entry = sessions.get(sessionId);
      if (entry && entry.endpoint !== payload.endpoint) { answer(400, '{}'); return; }
      if (payload.method === 'connect') {
        if (!entry) {
          if (sessions.size >= maxConcurrency) { answer(503, '{}'); return; }
          entry = { endpoint: payload.endpoint };
          const connection = entry;
          entry.rpc = new JsonPnnRpc(payload.endpoint, timeoutMs, (endpoint, maxBytes) => {
            connection.socket = createNodeBoundedPnnWebSocket(endpoint, maxBytes);
            return connection.socket;
          });
          sessions.set(sessionId, entry); touch(sessionId, entry);
          entry.ready = entry.rpc.connect();
        }
        await entry.ready; controller.signal.throwIfAborted();
        touch(sessionId, entry); answer(200, '{}'); return;
      }
      if (!entry) { answer(503, '{}'); return; }
      await entry.ready; touch(sessionId, entry);
      const params = payload.method === 'getUtxosByAddresses' ? payload.params.addresses : payload.params;
      const result = await entry.rpc[payload.method](params);
      controller.signal.throwIfAborted();
      const body = JSON.stringify(result);
      if (Buffer.byteLength(body) > MAX_BYTES) throw Error('PNN response limit');
      touch(sessionId, entry); answer(200, body);
    } catch { if (sessionId) drop(sessionId); answer(503, '{}'); }
    finally {
      clearTimeout(timer); active--;
      res.removeListener('close', disconnected);
      controller.signal.removeEventListener('abort', abortBody);
    }
  });
  server.requestTimeout = timeoutMs; server.headersTimeout = Math.min(timeoutMs, 10_000);
  server.maxConnections = 128;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return { origin: `http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`,
    async close() { for (const id of sessions.keys()) drop(id); server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const stat = fs.statSync(config.tokenFile);
  if (process.platform !== 'win32' && (stat.mode & 0o077)) throw Error('Relay token file must be private (0600)');
  const relay = await startDemoPnnRelay({ ...config, token: fs.readFileSync(config.tokenFile, 'utf8').trim() });
  console.log(`Demo PNN relay listening on ${relay.origin}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await relay.close(); process.exit(0); });
}

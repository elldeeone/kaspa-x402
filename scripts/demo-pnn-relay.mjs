import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import WebSocket from 'ws';
import { trustedNodeUrl } from '@kaspa-x402/adapters';

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
    const abortBody = () => { if (!req.complete) req.destroy(); };
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
      if (!payload || !allowed.has(payload.endpoint) || !METHODS.has(payload.method) ||
          !payload.params || typeof payload.params !== 'object' || Array.isArray(payload.params)) {
        answer(400, '{}'); return;
      }
      const body = await rpcCall(payload, controller.signal);
      answer(200, body);
    } catch { answer(503, '{}'); }
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
    async close() { server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}

function rpcCall({ endpoint, method, params }, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    // maxPayload covers fragmented/reassembled messages before JS delivery.
    const ws = new WebSocket(endpoint, { maxPayload: MAX_BYTES, perMessageDeflate: false,
      followRedirects: false });
    let settled = false; let messages = 0; let total = 0;
    const finish = (error, value) => {
      if (settled) return; settled = true;
      signal.removeEventListener('abort', abort);
      ws.terminate();
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(Error('PNN operation aborted'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    ws.on('error', () => finish(Error('PNN transport failed')));
    ws.on('close', () => finish(Error('PNN closed before response')));
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method, params })));
    ws.on('message', (raw, binary) => {
      try {
        total += raw.length;
        if (binary || ++messages > 5 || total > 2 * MAX_BYTES) throw Error('PNN response limit');
        const result = JSON.parse(raw.toString('utf8'));
        if (result.id !== 1) return;
        if (result.error !== undefined || !Object.hasOwn(result, 'params')) throw Error('PNN RPC failed');
        const body = JSON.stringify(result.params);
        if (Buffer.byteLength(body) > MAX_BYTES) throw Error('PNN response limit');
        finish(null, body);
      } catch (error) { finish(error); }
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const stat = fs.statSync(config.tokenFile);
  if (process.platform !== 'win32' && (stat.mode & 0o077)) throw Error('Relay token file must be private (0600)');
  const relay = await startDemoPnnRelay({ ...config, token: fs.readFileSync(config.tokenFile, 'utf8').trim() });
  console.log(`Demo PNN relay listening on ${relay.origin}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await relay.close(); process.exit(0); });
}

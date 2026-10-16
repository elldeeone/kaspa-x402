import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
assert.ok(args.includes('--out'), '--out is required');
const out = value('--out');
const origin = value('--origin') ?? 'http://127.0.0.1:8795';
const token = args.includes('--token-file') ? fs.readFileSync(value('--token-file'), 'utf8').trim() : crypto.randomBytes(32).toString('hex');
const endpoint = 'wss://vector-10.kaspa.green/kaspa/testnet-10/wrpc/json';
const report = { ok: false, origin, startedAt: new Date().toISOString(), cases: [] };
let local;
try {
  if (!args.includes('--origin')) {
    assert.ok(fs.existsSync('infra/demo-pnn-relay/wrangler.jsonc'), 'Container deployment configuration is missing');
    fs.writeFileSync(out + '.env', `RELAY_TOKEN=${token}\n`, { mode: 0o600 });
    local = spawn('infra/demo-pnn-relay/node_modules/.bin/wrangler', ['dev', '--config', 'infra/demo-pnn-relay/wrangler.jsonc', '--port', '8795',
      '--env-file', path.resolve(out + '.env')], { stdio: ['ignore', 'pipe', 'pipe'] });
    const log = fs.createWriteStream(out + '.worker.log', { mode: 0o600 });
    local.stdout.pipe(log); local.stderr.pipe(log);
    for (let i = 0; i < 600; i++) {
      try { if ((await fetch(origin + '/rpc', { signal: AbortSignal.timeout(1000) })).status === 401) break; }
      catch {}
      assert.equal(local.exitCode, null, 'Local container Worker exited');
      await new Promise(r => setTimeout(r, 500));
    }
  }
  const call = (payload, auth = token, pathname = '/rpc', method = 'POST') => fetch(origin + pathname, {
    method, headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    ...(method === 'GET' ? {} : { body: typeof payload === 'string' ? payload : JSON.stringify(payload) }),
    signal: AbortSignal.timeout(60000), redirect: 'error',
  });
  const check = async (name, fn) => { await fn(); report.cases.push({ name, passed: true }); };
  await check('unauthorized requests fail closed', async () => assert.equal((await call({}, 'wrong')).status, 401));
  await check('paths and methods are restricted', async () => {
    assert.equal((await call({}, token, '/admin')).status, 404);
    assert.equal((await call({}, token, '/rpc', 'GET')).status, 404);
  });
  const sessionId = crypto.randomUUID();
  const rpc = (method, params = {}, node = endpoint) => call({ sessionId, endpoint: node, method, params });
  await check('destination and method allowlists remain enforced', async () => {
    assert.equal((await rpc('connect', {}, 'wss://example.com/')).status, 400);
    assert.equal((await rpc('subscribeBlockAdded')).status, 400);
  });
  await check('container reaches a synced Testnet node through the bounded relay', async () => {
    const connected = await rpc('connect'); assert.equal(connected.status, 200, await connected.text());
    for (let i = 0; i < 2; i++) {
      const response = await rpc('getServerInfo'); assert.equal(response.status, 200);
      const info = await response.json(); assert.equal(info.networkId, 'testnet-10'); assert.equal(info.isSynced, true);
    }
    assert.equal((await rpc('disconnect')).status, 200);
  });
  await check('oversized request bodies remain bounded', async () => assert.equal((await call('a'.repeat(4_259_841))).status, 413));
  report.ok = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  local?.kill('SIGTERM');
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report));
}

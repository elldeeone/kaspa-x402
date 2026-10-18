// Funded E2E: built browser -> actual Worker/SQLite DO -> bounded relay -> Testnet-10.
// Origin mapping is local only. No payment, wallet, signing or node API is mocked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { startDemoPnnRelay } from './demo-pnn-relay.mjs';
import { liveChainCheckpoint, getAddressUtxos, waitForAcceptedTransactionEvidence } from '../protocol/scripts/live-adapter-reference.mjs';

const releaseVersion = JSON.parse(fs.readFileSync(new URL('../protocol/packages/core/package.json', import.meta.url))).version;
const option = name => process.argv[process.argv.indexOf(name) + 1];
assert.ok(process.argv.includes('--live') && process.argv.includes('--config') && process.argv.includes('--out'),
  'Usage: --live --config <private-json> --out <fresh-private-directory>');
const config = JSON.parse(fs.readFileSync(option('--config'), 'utf8'));
const hosted = process.argv.includes('--hosted');
const out = path.resolve(option('--out'));
assert.ok(!fs.existsSync(out), 'Use a fresh run directory; failed attempts must be retained');
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const sourceStatus = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
assert.ok(!sourceStatus || process.argv.includes('--allow-dirty'),
  'Commit the candidate before release proof, or use --allow-dirty for a development proof');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const privateWrite = (file, data) => fs.writeFileSync(path.join(out, file), JSON.stringify(data, (_, v) => typeof v === 'bigint' ? String(v) : v, 2) + '\n', { mode: 0o600 });
const requireSdk = createRequire(config.sdkModule);
globalThis.WebSocket = requireSdk('websocket').w3cwebsocket;
const sdk = requireSdk(config.sdkModule);
const rpc = new sdk.RpcClient({ url: config.rpcUrl, networkId: 'testnet-10' });
const report = { revision, sourceState: sourceStatus ? 'development-worktree' : 'git-head',
  sourceStatus, sourceDiffSha256: crypto.createHash('sha256').update(execFileSync('git', ['diff', 'HEAD', '--binary'])).digest('hex'),
  harnessSha256: crypto.createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex'), startedAt: new Date().toISOString(), network: 'kaspa:testnet-10',
  environment: hosted ? 'Public HTTPS website and deployed Cloudflare Worker/SQLite DO, funded Testnet-10' : 'Local HTTPS browser preview and actual Worker/SQLite DO, funded public Testnet-10',
  independentlyOperatedSources: 1, broadcasts: [], ok: false };
let worker, relay, server, browser, ws;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'x402-funded-browser-'));
const keyText = fs.readFileSync(config.walletFile, 'utf8').trim();
const fundingKey = new sdk.PrivateKey(keyText.startsWith('{') ? JSON.parse(keyText).private_key : keyText);
const fundingAddress = fundingKey.toAddress('testnet-10').toString();
const preparedRun = config.reusePreparedRun ? path.resolve(config.reusePreparedRun) : undefined;
const payerKey = new sdk.PrivateKey(preparedRun
  ? fs.readFileSync(path.join(preparedRun, 'payer-key'), 'utf8').trim()
  : crypto.randomBytes(32).toString("hex"));
fs.writeFileSync(path.join(out, 'payer-key'), payerKey.toString(), { mode: 0o600 });
const payerAddress = payerKey.toAddress('testnet-10').toString();
const admin = hosted ? fs.readFileSync(config.adminTokenFile, 'utf8').trim() : crypto.randomBytes(32).toString('hex');
const token = crypto.randomBytes(32).toString('hex');
const base = 'https://demo.kaspa-x402.org';
const save = () => privateWrite('report.json', report);
const wire = [];
try {
  await rpc.connect({ timeoutDuration: 15000, retries: 2 });
  const info = await rpc.getServerInfo();
  assert.equal(info.networkId, 'testnet-10'); assert.ok(info.isSynced && info.hasUtxoIndex);
  const before = await getAddressUtxos(rpc, fundingAddress);
  report.initialFundingSompi = before.reduce((s, u) => s + BigInt(u.amount), 0n).toString();
  report.runtime = Object.fromEntries(['packages/demo-gateway/dist/index.js', 'site/dist/assets/demo.js',
    'site/dist/assets/hash-chain-client.js', 'scripts/demo-pnn-relay.mjs'].map(f => [f,
    crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
  save();
  let registration;
  if (hosted) {
    report.siteRelease = await (await fetch('https://kaspa-x402.org/release.json', { redirect: 'error' })).json();
    report.gatewayHealth = await (await fetch(base + '/health', { redirect: 'error' })).json();
    assert.equal(report.siteRelease.version, releaseVersion);
    assert.equal(report.siteRelease.sourceState, 'git-head');
    assert.equal(report.gatewayHealth.releaseVersion, releaseVersion);
    assert.equal(report.gatewayHealth.enabled, true);
    // Read-only preflight before creating or funding anything. The hosted
    // pool belongs to the deployed service; a proof consumes its ready head.
    const fetchJson = async (route, options) => {
      const response = await fetch(base + route, { ...options, redirect: 'error', signal: AbortSignal.timeout(60000) });
      assert.equal(response.status, 200, `Hosted preflight ${route}: HTTP ${response.status}`);
      return response.json();
    };
    const status = await fetchJson('/hash-chain/status');
    report.preflight = { status, broadcasts: report.broadcasts.length }; save();
    assert.equal(status.network, 'kaspa:testnet-10');
    assert.ok(status.available && status.phase === 'ready' && status.readyHeads > 0,
      'Hosted head is unavailable; no setup funds were spent');
    assert.equal(status.capacity, 1, 'This browser proof requires a single-head hosted pool');
    registration = (await fetchJson('/admin/hash-chain', { headers: { authorization: `Bearer ${admin}` } })).head;
    assert.equal(registration.phase, 'ready');
    assert.equal(registration.network, 'kaspa:testnet-10');
    assert.equal(registration.headVersion, status.headVersion);
    assert.equal(registration.head.amount, status.headAmount);
    const spk = new sdk.ScriptPublicKey(parseInt(registration.head.scriptPublicKey.slice(0, 4), 16), registration.head.scriptPublicKey.slice(4));
    const address = sdk.addressFromScriptPublicKey(spk, 'testnet-10').toString();
    const observed = (await getAddressUtxos(rpc, address)).find(u =>
      u.outpoint.txid === registration.head.outpoint.txid && u.outpoint.index === registration.head.outpoint.index);
    assert.ok(observed && observed.amount === registration.head.amount &&
      observed.scriptPublicKey === registration.head.scriptPublicKey && observed.covenantId === registration.head.covenantId,
      'Hosted head is stale or differs from the node UTXO; no setup funds were spent');
    report.headBefore = { outpoint: registration.head.outpoint, amount: registration.head.amount, version: registration.headVersion };
    report.preflight.ok = true; save();
  }
  if (preparedRun) {
    const prior = JSON.parse(fs.readFileSync(path.join(preparedRun, 'report.json')));
    assert.equal(prior.network, 'kaspa:testnet-10');
    assert.ok(!prior.payment, 'Do not reuse a run that already attempted a browser payment');
    if (!hosted) {
      fs.cpSync(path.join(preparedRun, 'head'), path.join(out, 'head'), { recursive: true });
      registration = JSON.parse(fs.readFileSync(path.join(out, 'head/cloudflare-head.json')));
    }
    report.preparedInRevision = prior.revision;
    report.broadcasts = prior.broadcasts.filter(t => !hosted || t.role === 'payer-funding').map(t => ({ ...t, reusedPreparation: true }));
    assert.equal(report.broadcasts.length, hosted ? 1 : 2);
    const funding = await getAddressUtxos(rpc, payerAddress);
    assert.ok(funding.some(u => !u.covenantId && BigInt(u.amount) >= 21_000_000n),
      'Prepared payer needs an unspent input covering the 20m quote and 1m target fee');
    save();
  } else {
  if (!hosted) {
  const setupConfig = { ...config, dataDir: path.join(out, 'head') };
  privateWrite('setup.json', setupConfig);
  // Existing operator command persists owner keys and signed setup before broadcast.
  const init = execFileSync(process.execPath, ['scripts/hash-chain-demo.mjs', 'init', '--config', path.join(out, 'setup.json'), '--live'],
    { encoding: 'utf8', timeout: 180000 });
  fs.writeFileSync(path.join(out, 'setup.log'), init);
  registration = JSON.parse(fs.readFileSync(path.join(out, 'head/cloudflare-head.json')));
  report.broadcasts.push({ role: 'head-genesis', transactionId: registration.head.outpoint.txid, feeSompi: '1000000' });
  save();
  }
  const source = (await getAddressUtxos(rpc, fundingAddress)).find(u => !u.covenantId && BigInt(u.amount) > 100_000_000n);
  assert.ok(source, 'Insufficient isolated wallet funding');
  const script = new sdk.ScriptPublicKey(parseInt(source.scriptPublicKey.slice(0, 4), 16), source.scriptPublicKey.slice(4));
  const shape = { version: 0, lockTime: 0n, subnetworkId: '00'.repeat(20), gas: 0n, payload: '',
    outputs: [{ value: 70_000_000n, scriptPublicKey: sdk.payToAddressScript(payerAddress) },
      { value: BigInt(source.amount) - 71_000_000n, scriptPublicKey: sdk.payToAddressScript(fundingAddress) }] };
  const input = { previousOutpoint: { transactionId: source.outpoint.txid, index: source.outpoint.index },
    sequence: 0n, sigOpCount: 1, utxo: { outpoint: { transactionId: source.outpoint.txid, index: source.outpoint.index },
      amount: BigInt(source.amount), scriptPublicKey: script, blockDaaScore: 0n, isCoinbase: false } };
  const unsigned = new sdk.Transaction({ ...shape, inputs: [{ ...input, signatureScript: '' }] });
  const signed = new sdk.Transaction({ ...shape, inputs: [{ ...input,
    signatureScript: sdk.createInputSignature(unsigned, 0, fundingKey, sdk.SighashType.All) }] });
  const checkpoint = await liveChainCheckpoint(rpc);
  privateWrite('payer-funding.json', { transaction: signed.serializeToSafeJSON(), transactionId: signed.id, checkpoint });
  const submitted = await rpc.submitTransaction({ transaction: signed, allowOrphan: false });
  assert.equal(submitted.transactionId, signed.id);
  report.broadcasts.push({ role: 'payer-funding', transactionId: signed.id, feeSompi: '1000000' }); save();
  await waitForAcceptedTransactionEvidence({ rpc, transactionId: signed.id, fromCheckpoint: checkpoint, minConfirmationCount: 30 });
  }
  if (!hosted) {
  const endpoint = config.rpcUrl.replace('/wrpc/borsh', '/wrpc/json');
  relay = await startDemoPnnRelay({ endpoints: [endpoint], token });
  const require = createRequire(createRequire(import.meta.url).resolve('wrangler/package.json'));
  const { Miniflare, convertV4MiniflareOptions } = await import(require.resolve('miniflare'));
  const options = { modules: true, scriptPath: path.resolve('packages/demo-gateway/dist/index.js'),
    compatibilityDate: '2026-06-02', compatibilityFlags: ['nodejs_compat', 'enable_request_signal', 'request_signal_passthrough'],
    durableObjects: { GATEWAY_STATE: { className: 'GatewayState', useSQLite: true } },
    durableObjectsPersist: path.join(out, 'worker-state'),
    resourcePersistencePath: path.join(out, 'worker-state'),
    bindings: { KASPA_X402_GATEWAY_ENABLED: 'true', KASPA_X402_HASH_CHAIN_ENABLED: 'true',
      KASPA_X402_CHAIN_TRUST_MODE: 'trusted-single-source', KASPA_X402_ADMISSION_HMAC_KEY: token,
      KASPA_X402_ADMIN_TOKEN: admin, KASPA_X402_RELEASE_VERSION: releaseVersion,
      KASPA_X402_PAY_TO: fundingAddress, KASPA_X402_SERVER_PUBLIC_KEY: registration.ownerPublicKey,
      KASPA_X402_GATEWAY_BASE_URL: base, KASPA_X402_HOSTED_EXACT_SETTLEMENT_ENABLED: 'true',
      KASPA_X402_CORS_ORIGIN: 'https://kaspa-x402.org',
      KASPA_X402_PNN_ENDPOINTS: endpoint, KASPA_X402_PNN_RPC_ORIGIN: relay.origin,
      KASPA_X402_PNN_RPC_TOKEN: token, KASPA_X402_ALLOW_INSECURE_LOOPBACK: 'true',
      KASPA_X402_CLAIM_FEE_SOMPI: '1000000',
    } };
  privateWrite('worker-bindings.json', options.bindings);
  worker = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
  }
  const dispatch = hosted ? (url, options) => fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(60000) }) : (url, options) => worker.dispatchFetch(url, options);
  if (!hosted) {
  const registered = await dispatch(base + '/admin/hash-chain/register', { method: 'POST',
    headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' }, body: JSON.stringify(registration) });
  assert.equal(registered.status, 200, await registered.clone().text());
  report.headBefore = { outpoint: registration.head.outpoint, amount: registration.head.amount, version: 0 }; save();
  }
  const expectedHeadAmount = (BigInt(report.headBefore.amount) + 20_000_000n).toString();
  const expectedHeadVersion = Number(report.headBefore.version) + 1;
  let port;
  if (!hosted) {
  const tls = path.join(out, 'tls'); fs.mkdirSync(tls);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', tls + '/key.pem',
    '-out', tls + '/cert.pem', '-days', '1', '-subj', '/CN=kaspa-x402.org'], { stdio: 'ignore' });
  server = https.createServer({ key: fs.readFileSync(tls + '/key.pem'), cert: fs.readFileSync(tls + '/cert.pem') }, async (req, res) => {
    try {
      if (req.headers.host?.startsWith('demo.kaspa-x402.org')) {
        let body = ''; for await (const part of req) { body += part; assert.ok(body.length < 128 * 1024); }
        const headers = new Headers(req.headers); headers.set('cf-connecting-ip', '192.0.2.10');
        const result = await worker.dispatchFetch(base + req.url, { method: req.method, headers,
          ...(body ? { body } : {}) });
        wire.push({ path: req.url.split('?')[0], method: req.method, status: result.status,
          paid: !!headers.get('payment-signature') });
        report.wire = wire; save();
        res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(await result.text()); return;
      }
      const pathname = new URL(req.url, 'https://kaspa-x402.org').pathname;
      const file = path.resolve('site/dist', '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname));
      assert.ok(file.startsWith(path.resolve('site/dist') + path.sep));
      const headers = { 'content-type': file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' :
        file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream' };
      // Apply the generated site's actual CSP and cross-origin isolation headers.
      let pattern;
      for (const line of fs.readFileSync('site/dist/_headers', 'utf8').split('\n')) {
        if (!line.startsWith(' ') && !line.startsWith('\t')) { pattern = line.trim(); continue; }
        if (pattern !== '/*' && pattern !== '/demo/*' && pattern !== pathname) continue;
        if (pattern === '/demo/*' && !pathname.startsWith('/demo/')) continue;
        const match = line.trim().match(/^([^:]+):\s*(.*)$/); if (match) headers[match[1]] = match[2];
      }
      res.writeHead(200, headers); res.end(fs.readFileSync(file));
    } catch { res.writeHead(500); res.end('{}'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  }
  // Chromium host rules map the two real HTTPS origins to this local preview.
  const chrome = config.chrome ?? process.env.CHROME_BIN ?? 'google-chrome';
  browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu',
    ...(!hosted ? ['--ignore-certificate-errors', `--host-resolver-rules=MAP kaspa-x402.org 127.0.0.1:${port},MAP demo.kaspa-x402.org 127.0.0.1:${port}`] : []),
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; browser.stderr.on('data', chunk => { stderr += chunk; });
  for (let i = 0; i < 100 && !stderr.includes('DevTools listening on'); i++) await new Promise(r => setTimeout(r, 100));
  const debugUrl = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1]; assert.ok(debugUrl, 'Chrome did not start');
  const debugOrigin = new URL(debugUrl); const devtools = `http://${debugOrigin.host}`;
  const target = await (await fetch(devtools + '/json/new?about:blank', { method: 'PUT' })).json();
  ws = new (await import('ws')).default(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  let nextId = 1; const pending = new Map(); const errors = [];
  const requests = new Map();
  ws.on('message', raw => { const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
    if (hosted && m.method === 'Network.requestWillBeSent' && m.params.request.url.startsWith(base + '/')) {
      const request = m.params.request;
      requests.set(m.params.requestId, { path: new URL(request.url).pathname, method: request.method,
        paid: Object.keys(request.headers).some(h => h.toLowerCase() === 'payment-signature') });
    }
    if (hosted && m.method === 'Network.responseReceived' && requests.has(m.params.requestId)) {
      wire.push({ ...requests.get(m.params.requestId), status: m.params.response.status }); report.wire = wire; save();
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++; const timer = setTimeout(() => { pending.delete(id); reject(Error(`Browser command timed out: ${method}`)); }, 240_000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable'); await send('Page.enable');
  if (hosted) await send('Network.enable');
  await send('Page.navigate', { url: 'https://kaspa-x402.org/demo/' });
  const evaluate = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    assert.ok(!r.result.exceptionDetails, JSON.stringify(r.result.exceptionDetails)); return r.result.result.value;
  };
  for (let i = 0; i < 100; i++) { if (await evaluate('document.readyState === "complete" && !!document.getElementById("demo-private-key")')) break; await new Promise(r => setTimeout(r, 100)); }
  await evaluate(`(async()=>{
    const e=id=>document.getElementById(id);
    const wait=async fn=>{for(let i=0;i<1800;i++){if(fn())return;await new Promise(r=>setTimeout(r,100));}throw Error(e('demo-status').value+'; '+e('demo-hash-status').value)};
    e('demo-private-key').value=${JSON.stringify(payerKey.toString())};
    e('demo-import-key').click(); await wait(()=>e('demo-address').value===${JSON.stringify(payerAddress)});
    e('demo-connect').click(); await wait(()=>e('demo-status').value.startsWith('Connected to testnet-10'));
    e('demo-hash-quote').click(); await wait(()=>!e('demo-hash-pay').disabled);
    e('demo-hash-pay').click(); await wait(()=>e('demo-hash-status').value.startsWith('Payment accepted.'));
    return true;
  })()`);
  const payment = await evaluate('JSON.parse(document.getElementById("demo-hash-output").textContent)');
  report.payment = payment; report.broadcasts.push({ role: 'browser-payment', transactionId: payment.transactionId, feeSompi: payment.feeSompi }); save();
  assert.equal(String(payment.headBefore.version), String(report.headBefore.version));
  assert.equal(payment.headBefore.amount, report.headBefore.amount);
  assert.equal(payment.headAfter.amount, expectedHeadAmount);
  await evaluate(`(async()=>{document.getElementById('demo-hash-retry').click(); for(let i=0;i<1200;i++){
    if(document.getElementById('demo-hash-status').value.startsWith('Payment accepted.'))return;
    await new Promise(r=>setTimeout(r,100));}throw Error('retry timed out')})()`);
  const retry = await evaluate('JSON.parse(document.getElementById("demo-hash-output").textContent)');
  assert.equal(retry.transactionId, payment.transactionId);
  const status = await (await dispatch(base + '/hash-chain/status')).json();
  assert.equal(status.headVersion, expectedHeadVersion); assert.equal(status.headAmount, expectedHeadAmount);
  const head = (await (await dispatch(base + '/admin/hash-chain', { headers: { authorization: `Bearer ${admin}` } })).json()).head;
  const headAddress = new sdk.ScriptPublicKey(parseInt(head.head.scriptPublicKey.slice(0, 4), 16), head.head.scriptPublicKey.slice(4));
  const address = sdk.addressFromScriptPublicKey(headAddress, 'testnet-10').toString();
  // Reconnect the independent observer after browser/Worker work; an idle
  // setup socket may have closed while the separate browser paid.
  await rpc.disconnect().catch(() => {});
  await rpc.connect({ timeoutDuration: 15000, retries: 2 });
  const observedInfo = await rpc.getServerInfo();
  assert.equal(observedInfo.networkId, 'testnet-10'); assert.ok(observedInfo.isSynced);
  const found = (await getAddressUtxos(rpc, address)).find(u => u.outpoint.txid === payment.transactionId);
  assert.ok(found && found.amount === expectedHeadAmount, 'Node did not independently observe the funded successor');
  assert.ok(wire.some(w => w.method === 'GET' && w.status === 402));
  assert.ok(wire.some(w => w.method === 'POST' && w.path === '/hash-chain/grant' && w.status === 200));
  assert.ok(wire.filter(w => w.paid && w.status === 200).length >= 2);
  report.wire = wire; report.browserExceptions = errors; assert.deepEqual(errors, []);
  report.headAfter = { outpoint: found.outpoint, amount: found.amount, version: expectedHeadVersion };
  report.totalFeesSompi = report.broadcasts.reduce((sum, t) => sum + BigInt(t.feeSompi), 0n).toString();
  assert.ok(BigInt(report.totalFeesSompi) <= 100_000_000n, 'Fee budget exceeded');
  report.retrySameTransaction = true; report.ok = true; save();
  console.log(JSON.stringify({ ok: true, revision, transactionId: payment.transactionId, totalFeesSompi: report.totalFeesSompi }));
} catch (error) { report.error = error.message; save(); throw error; }
finally {
  ws?.close(); browser?.kill('SIGTERM');
  if (server) await new Promise(r => server.close(r));
  await worker?.dispose(); await relay?.close(); await rpc.disconnect().catch(() => {});
  rpc.free();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

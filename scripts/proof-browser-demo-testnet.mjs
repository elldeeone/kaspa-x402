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

const option = name => process.argv[process.argv.indexOf(name) + 1];
assert.ok(process.argv.includes('--live') && process.argv.includes('--config') && process.argv.includes('--out'),
  'Usage: --live --config <private-json> --out <fresh-private-directory>');
const config = JSON.parse(fs.readFileSync(option('--config'), 'utf8'));
const out = path.resolve(option('--out'));
assert.ok(!fs.existsSync(out), 'Use a fresh run directory; failed attempts must be retained');
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
assert.equal(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'Commit the candidate before funded proof');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const privateWrite = (file, data) => fs.writeFileSync(path.join(out, file), JSON.stringify(data, (_, v) => typeof v === 'bigint' ? String(v) : v, 2) + '\n', { mode: 0o600 });
const requireSdk = createRequire(config.sdkModule);
globalThis.WebSocket = requireSdk('websocket').w3cwebsocket;
const sdk = requireSdk(config.sdkModule);
const rpc = new sdk.RpcClient({ url: config.rpcUrl, networkId: 'testnet-10' });
const report = { revision, startedAt: new Date().toISOString(), network: 'kaspa:testnet-10',
  environment: 'Local HTTPS browser preview and actual Worker/SQLite DO, funded public Testnet-10',
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
const admin = crypto.randomBytes(32).toString('hex');
const token = crypto.randomBytes(32).toString('hex');
const base = 'https://demo.kaspa-x402.org';
const save = () => privateWrite('report.json', report);
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
  if (preparedRun) {
    const prior = JSON.parse(fs.readFileSync(path.join(preparedRun, 'report.json')));
    assert.equal(prior.network, 'kaspa:testnet-10');
    assert.ok(!prior.payment, 'Do not reuse a run that already attempted a browser payment');
    fs.cpSync(path.join(preparedRun, 'head'), path.join(out, 'head'), { recursive: true });
    registration = JSON.parse(fs.readFileSync(path.join(out, 'head/cloudflare-head.json')));
    report.preparedInRevision = prior.revision;
    report.broadcasts = prior.broadcasts.map(t => ({ ...t, reusedPreparation: true }));
    assert.equal(report.broadcasts.length, 2);
    const funding = await getAddressUtxos(rpc, payerAddress);
    assert.ok(funding.some(u => u.amount === '70000000'), 'Prepared payer funding is spent');
    save();
  } else {
  const setupConfig = { ...config, dataDir: path.join(out, 'head') };
  privateWrite('setup.json', setupConfig);
  // Existing operator command persists owner keys and signed setup before broadcast.
  const init = execFileSync(process.execPath, ['scripts/hash-chain-demo.mjs', 'init', '--config', path.join(out, 'setup.json'), '--live'],
    { encoding: 'utf8', timeout: 180000 });
  fs.writeFileSync(path.join(out, 'setup.log'), init);
  registration = JSON.parse(fs.readFileSync(path.join(out, 'head/cloudflare-head.json')));
  report.broadcasts.push({ role: 'head-genesis', transactionId: registration.head.outpoint.txid, feeSompi: '1000000' });
  save();
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
  const endpoint = config.rpcUrl.replace('/wrpc/borsh', '/wrpc/json');
  relay = await startDemoPnnRelay({ endpoints: [endpoint], token });
  const require = createRequire(createRequire(import.meta.url).resolve('wrangler/package.json'));
  const { Miniflare, convertV4MiniflareOptions } = await import(require.resolve('miniflare'));
  const options = { modules: true, scriptPath: path.resolve('packages/demo-gateway/dist/index.js'),
    compatibilityDate: '2026-06-02', compatibilityFlags: ['nodejs_compat', 'enable_request_signal', 'request_signal_passthrough'],
    durableObjects: { GATEWAY_STATE: { className: 'GatewayState', useSQLite: true } },
    durableObjectsPersist: path.join(out, 'worker-state'),
    bindings: { KASPA_X402_GATEWAY_ENABLED: 'true', KASPA_X402_HASH_CHAIN_ENABLED: 'true',
      KASPA_X402_CHAIN_TRUST_MODE: 'trusted-single-source', KASPA_X402_ADMISSION_HMAC_KEY: token,
      KASPA_X402_ADMIN_TOKEN: admin, KASPA_X402_RELEASE_VERSION: '1.0.0',
      KASPA_X402_PAY_TO: fundingAddress, KASPA_X402_SERVER_PUBLIC_KEY: registration.ownerPublicKey,
      KASPA_X402_GATEWAY_BASE_URL: base, KASPA_X402_HOSTED_EXACT_SETTLEMENT_ENABLED: 'true',
      KASPA_X402_CORS_ORIGIN: 'https://kaspa-x402.org',
      KASPA_X402_PNN_ENDPOINTS: endpoint, KASPA_X402_PNN_RPC_ORIGIN: relay.origin,
      KASPA_X402_PNN_RPC_TOKEN: token, KASPA_X402_ALLOW_INSECURE_LOOPBACK: 'true',
      KASPA_X402_CLAIM_FEE_SOMPI: '1000000',
    } };
  worker = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
  const registered = await worker.dispatchFetch(base + '/admin/hash-chain/register', { method: 'POST',
    headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' }, body: JSON.stringify(registration) });
  assert.equal(registered.status, 200, await registered.clone().text());
  report.headBefore = { outpoint: registration.head.outpoint, amount: registration.head.amount, version: '0' }; save();
  const tls = path.join(out, 'tls'); fs.mkdirSync(tls);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', tls + '/key.pem',
    '-out', tls + '/cert.pem', '-days', '1', '-subj', '/CN=kaspa-x402.org'], { stdio: 'ignore' });
  const wire = [];
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
  const port = server.address().port;
  // Chromium host rules map the two real HTTPS origins to this local preview.
  const chrome = config.chrome ?? process.env.CHROME_BIN ?? 'google-chrome';
  browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--ignore-certificate-errors',
    `--host-resolver-rules=MAP kaspa-x402.org 127.0.0.1:${port},MAP demo.kaspa-x402.org 127.0.0.1:${port}`,
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; browser.stderr.on('data', chunk => { stderr += chunk; });
  for (let i = 0; i < 100 && !stderr.includes('DevTools listening on'); i++) await new Promise(r => setTimeout(r, 100));
  const debugUrl = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1]; assert.ok(debugUrl, 'Chrome did not start');
  const debugOrigin = new URL(debugUrl); const devtools = `http://${debugOrigin.host}`;
  const target = await (await fetch(devtools + '/json/new?about:blank', { method: 'PUT' })).json();
  ws = new (await import('ws')).default(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  let nextId = 1; const pending = new Map(); const errors = [];
  ws.on('message', raw => { const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++; const timer = setTimeout(() => { pending.delete(id); reject(Error(`Browser command timed out: ${method}`)); }, 240_000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable'); await send('Page.enable');
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
  assert.equal(payment.headAfter.amount, '120000000');
  await evaluate(`(async()=>{document.getElementById('demo-hash-retry').click(); for(let i=0;i<1200;i++){
    if(document.getElementById('demo-hash-status').value.startsWith('Payment accepted.'))return;
    await new Promise(r=>setTimeout(r,100));}throw Error('retry timed out')})()`);
  const retry = await evaluate('JSON.parse(document.getElementById("demo-hash-output").textContent)');
  assert.equal(retry.transactionId, payment.transactionId);
  const status = await (await worker.dispatchFetch(base + '/hash-chain/status')).json();
  assert.equal(status.headVersion, 1); assert.equal(status.headAmount, '120000000');
  const head = (await (await worker.dispatchFetch(base + '/admin/hash-chain', { headers: { authorization: `Bearer ${admin}` } })).json()).head;
  const headAddress = new sdk.ScriptPublicKey(parseInt(head.head.scriptPublicKey.slice(0, 4), 16), head.head.scriptPublicKey.slice(4));
  const address = sdk.addressFromScriptPublicKey(headAddress, 'testnet-10').toString();
  // Reconnect the independent observer after browser/Worker work; an idle
  // setup socket may have closed while the separate browser paid.
  await rpc.disconnect().catch(() => {});
  await rpc.connect({ timeoutDuration: 15000, retries: 2 });
  const observedInfo = await rpc.getServerInfo();
  assert.equal(observedInfo.networkId, 'testnet-10'); assert.ok(observedInfo.isSynced);
  const found = (await getAddressUtxos(rpc, address)).find(u => u.outpoint.txid === payment.transactionId);
  assert.ok(found && found.amount === '120000000', 'Node did not independently observe the funded successor');
  assert.ok(wire.some(w => w.method === 'GET' && w.status === 402));
  assert.ok(wire.some(w => w.method === 'POST' && w.path === '/hash-chain/grant' && w.status === 200));
  assert.ok(wire.filter(w => w.paid && w.status === 200).length >= 2);
  report.wire = wire; report.browserExceptions = errors; assert.deepEqual(errors, []);
  report.headAfter = { outpoint: found.outpoint, amount: found.amount, version: 1 };
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

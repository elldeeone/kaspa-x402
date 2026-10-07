import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { HashChainGrantIssuer } from '@kaspa-x402/server/hash-chain-grants';
import { HashChainRestView } from '@kaspa-x402/server';
import {
  buildHashChainHeadRedeemScript, buildHashChainOwnerRotationSignatureScript,
  buildTxV1P2pkSignatureScript, calculateKaspaStorageMass, generateHashChainBorrowGrants,
  hashChainHeadScriptPublicKey, transactionV1CovenantId, transactionV1Id, transactionV1Sighash,
} from '@kaspa-x402/covenant';
import { getAddressUtxos, liveChainCheckpoint, referenceTransactionToSdk,
  waitForAcceptedTransactionEvidence } from '../protocol/scripts/live-adapter-reference.mjs';
import { createHashChainDemoHandler } from './hash-chain-demo-service.mjs';
import { openHashChainDemoStore } from './hash-chain-demo-store.mjs';

const [command, ...args] = process.argv.slice(2);
const configIndex = args.indexOf('--config');
if (!['serve', 'init', 'rotate', 'recover', 'status', 'publish'].includes(command) || configIndex < 0 || !args[configIndex + 1]) {
  throw new Error('Usage: hash-chain-demo.mjs <init|serve|status|rotate|recover|publish> --config <private-json-file> [--live]');
}
if (['init', 'rotate'].includes(command) && !args.includes('--live')) {
  throw new Error(`${command} broadcasts Testnet-10 transactions; add --live explicitly.`);
}
const config = JSON.parse(fs.readFileSync(path.resolve(args[configIndex + 1]), 'utf8'));
const dataDir = path.resolve(config.dataDir);
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const keyFile = path.join(dataDir, 'grant-store-key');
if (command === 'init' && !fs.existsSync(keyFile)) privateWrite(keyFile, randomBytes(32).toString('hex'));
const issuer = await HashChainGrantIssuer.open({ databasePath: path.join(dataDir, 'grants.sqlite'),
  encryptionKey: Buffer.from(privateRead(keyFile), 'hex'), canClaim: () => true });
const headFile = path.join(dataDir, 'head.json');
const pendingFile = path.join(dataDir, 'pending-setup.json');
let rpc;
let http;
let payments;
try {
  if (command === 'publish') {
    const base = new URL(config.publicBaseUrl ?? 'https://demo.kaspa-x402.org');
    if (base.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(base.hostname)) throw new Error('Publishing private grants requires HTTPS');
    const registration = JSON.parse(privateRead(path.join(dataDir, 'cloudflare-head.json')));
    const current = issuer.getCurrent(registration.headId);
    if (current.phase !== 'ready' || current.headVersion !== 0) throw new Error('Publish only a fresh, unused head');
    const token = privateRead(path.resolve(config.adminTokenFile));
    const response = await fetch(new URL('/admin/hash-chain/register', base), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(registration), redirect: 'error', signal: AbortSignal.timeout(45_000),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(`Cloudflare head registration failed (${response.status})`);
    console.log(JSON.stringify({ command, headId: result.head.headId, phase: result.head.phase }));
  } else if (command === 'status') {
    const { headId } = JSON.parse(fs.readFileSync(headFile, 'utf8'));
    const current = issuer.getCurrent(headId);
    console.log(JSON.stringify({ headId, phase: current.phase, headVersion: current.headVersion, head: current.head }, null, 2));
  } else {
    const sdkPath = path.resolve(config.sdkModule);
    const sdkRequire = createRequire(sdkPath);
    globalThis.WebSocket = sdkRequire('websocket').w3cwebsocket;
    const sdk = sdkRequire(sdkPath);
    rpc = new sdk.RpcClient({ url: config.rpcUrl, networkId: 'testnet-10' });
    await rpc.connect({ timeoutDuration: 15_000, retries: 2 });
    const info = await rpc.getServerInfo();
    if (String(info.networkId) !== 'testnet-10' || !info.isSynced || !info.hasUtxoIndex) {
      throw new Error('Use a synced Testnet-10 node with its UTXO index enabled.');
    }
    if (command === 'recover') {
      const saved = JSON.parse(privateRead(pendingFile));
      const transaction = sdk.Transaction.deserializeFromSafeJSON(saved.transaction);
      if (transaction.id.toLowerCase() !== saved.transactionId) throw new Error('Saved setup transaction ID differs.');
      const artifact = JSON.parse(saved.transaction);
      const output = artifact.outputs[0];
      if (output.value !== saved.output.amount || output.scriptPublicKey !== saved.output.scriptPublicKey ||
          output.covenant?.covenantId !== saved.output.covenant.covenantId) {
        throw new Error('Saved setup head differs from its signed transaction.');
      }
      await waitForAcceptedTransactionEvidence({ rpc, transactionId: saved.transactionId,
        fromCheckpoint: saved.checkpoint, minConfirmationCount: saved.command === 'init' ? 30 : 1 });
      finishSetup(saved, sdk);
      console.log(JSON.stringify({ command, transactionId: saved.transactionId, phase: issuer.getCurrent(saved.headId).phase }));
    } else if (command === 'serve') {
      const { headId, ownerPublicKey, payTo } = JSON.parse(fs.readFileSync(headFile, 'utf8'));
      const proxyToken = privateRead(path.resolve(config.proxyTokenFile));
      if (proxyToken.length < 32) throw new Error('Proxy token must contain at least 32 characters.');
      const view = new HashChainRestView(config.apiBase ?? 'https://api-tn10.kaspa.org');
      payments = await openHashChainDemoStore(path.join(dataDir, 'payments.sqlite'));
      const handler = createHashChainDemoHandler({ issuer, headId, ownerPublicKey, payTo,
        store: payments.store,
        publicBaseUrl: config.publicBaseUrl ?? 'https://demo.kaspa-x402.org',
        amount: config.amountSompi ?? '20000000', chainView: view,
        addressCodec: {
          scriptPublicKeyForAddress(address) {
            const script = sdk.payToAddressScript(address);
            try { return script.toString(); } finally { script.free(); }
          },
          encodeScriptAddress({ serializedScriptPublicKey }) { return addressForScript(sdk, serializedScriptPublicKey); },
        },
        getCurrentUtxo: async (outpoint, signal) => {
          signal?.throwIfAborted();
          const current = issuer.getCurrent(headId).head;
          const entries = await getAddressUtxos(rpc, addressForScript(sdk, current.scriptPublicKey));
          signal?.throwIfAborted();
          const found = entries.find((item) => item.outpoint.txid === outpoint.txid && item.outpoint.index === outpoint.index);
          return found ? { outpoint: found.outpoint, amount: found.amount,
            scriptPublicKey: found.scriptPublicKey, covenantId: found.covenantId ?? null } : null;
        },
        getPayerFundingUtxo: async (payerPublicKey, required, signal) => {
          signal?.throwIfAborted();
          const payerScript = `000020${payerPublicKey}ac`;
          const entries = await getAddressUtxos(rpc, addressForScript(sdk, payerScript));
          signal?.throwIfAborted();
          return entries.some((item) => !item.covenantId &&
            item.scriptPublicKey === payerScript && BigInt(item.amount) >= BigInt(required));
        },
      });
      http = createServer(async (req, res) => {
        const disconnect = new AbortController();
        res.once('close', () => { if (!res.writableEnded) disconnect.abort(); });
        try {
          const given = Buffer.from(req.headers.authorization ?? '');
          const expected = Buffer.from(`Bearer ${proxyToken}`);
          if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
            res.writeHead(401, { 'cache-control': 'no-store' }); res.end('{}'); return;
          }
          const request = new Request(new URL(req.url, 'http://localhost'), {
            method: req.method, headers: req.headers, signal: disconnect.signal,
            ...(req.method === 'POST' ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
          });
          const response = await handler(request);
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(await response.text());
        } catch {
          if (!res.headersSent) res.writeHead(503, { 'cache-control': 'no-store' });
          res.end(JSON.stringify({ error: 'hash_chain_unavailable' }));
        }
      });
      http.requestTimeout = 20_000;
      http.headersTimeout = 10_000;
      await new Promise((resolve) => http.listen(config.port ?? 8788, config.host ?? '127.0.0.1', resolve));
      console.log(`Hash-chain Testnet-10 demo listening on ${config.host ?? '127.0.0.1'}:${http.address().port}`);
      await new Promise((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
      await new Promise((resolve) => http.close(resolve));
    } else {
      if (fs.existsSync(pendingFile)) throw new Error('An earlier setup attempt is pending. Use recover before another init or rotate.');
      const raw = privateRead(path.resolve(config.walletFile));
      const walletKey = raw.startsWith('{') ? JSON.parse(raw).private_key : raw;
      if (!/^[0-9a-fA-F]{64}$/.test(walletKey)) throw new Error('Wallet file must contain a Testnet private key.');
      const fundingAddress = new sdk.PrivateKey(walletKey).toAddress('testnet-10').toString();
      const funding = (await getAddressUtxos(rpc, fundingAddress))
        .filter((item) => !item.covenantId && BigInt(item.amount) >= (command === 'init' ? 101_000_000n : 11_000_000n))
        .sort((a, b) => BigInt(a.amount) < BigInt(b.amount) ? -1 : 1)[0];
      if (!funding) throw new Error('No suitable Testnet funding UTXO; fund the operator wallet and try again.');
      const grants = generateHashChainBorrowGrants(32);
      let headId, ownerPublicKey, ownerKey, unsigned, predecessor;
      if (command === 'init') {
        if (fs.existsSync(headFile)) throw new Error('Demo is already initialized; use rotate or a new data directory.');
        ownerKey = Buffer.from(schnorr.utils.randomSecretKey()).toString('hex');
        ownerPublicKey = Buffer.from(schnorr.getPublicKey(Buffer.from(ownerKey, 'hex'))).toString('hex');
        headId = randomBytes(32).toString('hex');
        privateWrite(path.join(dataDir, 'owner-key'), ownerKey);
        const output = { amount: '100000000', scriptPublicKey: hashChainHeadScriptPublicKey({ ownerPublicKey, guard: grants.initialGuard }), covenant: null };
        const covenantId = transactionV1CovenantId(funding.outpoint, [{ index: 0, output }]);
        unsigned = reference([refInput(funding, null)], [
          { ...output, covenant: { authorizingInput: 0, covenantId } },
          { amount: String(BigInt(funding.amount) - 101_000_000n), scriptPublicKey: funding.scriptPublicKey, covenant: null },
        ].filter((item) => BigInt(item.amount) > 0n));
      } else {
        ({ headId, ownerPublicKey } = JSON.parse(fs.readFileSync(headFile, 'utf8')));
        ownerKey = privateRead(path.join(dataDir, 'owner-key'));
        let current = issuer.getCurrent(headId);
        if (current.phase === 'assigned') { issuer.markAbandoned(headId); current = issuer.getCurrent(headId); }
        predecessor = current.head.outpoint;
        const currentUtxo = (await getAddressUtxos(rpc, addressForScript(sdk, current.head.scriptPublicKey)))
          .find((item) => item.outpoint.txid === predecessor.txid && item.outpoint.index === 0);
        if (!currentUtxo || currentUtxo.covenantId !== current.head.covenantId || currentUtxo.amount !== current.head.amount) {
          throw new Error('Current head has changed; reconcile its accepted payment before rotating.');
        }
        unsigned = reference([refInput(currentUtxo, current.head.covenantId), refInput(funding, null)], [
          { amount: current.head.amount, scriptPublicKey: hashChainHeadScriptPublicKey({ ownerPublicKey, guard: grants.initialGuard }),
            covenant: { authorizingInput: 0, covenantId: current.head.covenantId } },
          { amount: String(BigInt(funding.amount) - 1_000_000n), scriptPublicKey: funding.scriptPublicKey, covenant: null },
        ]);
        const signature = sign(unsigned, 0, ownerKey);
        unsigned.inputs[0].signatureScript = buildHashChainOwnerRotationSignatureScript({
          newGuard: grants.initialGuard, signature,
          redeemScript: buildHashChainHeadRedeemScript({ ownerPublicKey, guard: current.head.guard }),
        });
      }
      const fundingIndex = command === 'init' ? 0 : 1;
      unsigned.inputs[fundingIndex].signatureScript = buildTxV1P2pkSignatureScript(sign(unsigned, fundingIndex, walletKey));
      const transactionId = transactionV1Id(unsigned);
      const transaction = referenceTransactionToSdk(sdk, unsigned);
      if (transaction.id.toLowerCase() !== transactionId) throw new Error('SDK and reference transaction IDs differ.');
      // Preserve the exact keys and transaction before broadcast. An interrupted
      // operator can recover this attempt rather than generating another one.
      const checkpoint = await liveChainCheckpoint(rpc);
      const setup = { command, headId, ownerPublicKey, transactionId,
        transaction: transaction.serializeToSafeJSON(), grants, predecessor, checkpoint,
        output: unsigned.outputs[0] };
      privateWrite(pendingFile, JSON.stringify(setup));
      await rpc.submitTransaction({ transaction, allowOrphan: false });
      await waitForAcceptedTransactionEvidence({ rpc, transactionId, fromCheckpoint: checkpoint,
        minConfirmationCount: command === 'init' ? 30 : 1 });
      finishSetup(setup, sdk);
      console.log(JSON.stringify({ command, transactionId, headId, phase: issuer.getCurrent(headId).phase }));
    }
  }
} finally {
  await payments?.close();
  issuer.close();
  await rpc?.disconnect().catch(() => undefined);
}

function finishSetup(setup, sdk) {
  const { headId, ownerPublicKey, transactionId, output, grants, predecessor } = setup;
  const head = { outpoint: { txid: transactionId, index: 0 }, amount: output.amount,
    guard: grants.initialGuard, scriptPublicKey: output.scriptPublicKey, covenantId: output.covenant.covenantId };
  let alreadyRecorded = false;
  try { alreadyRecorded = issuer.getCurrent(headId).head.outpoint.txid === transactionId; } catch { /* new genesis */ }
  if (!alreadyRecorded) {
    if (setup.command === 'init') issuer.installHead({ headId, network: 'kaspa:testnet-10', ownerPublicKey, head, grants: grants.grants });
    else issuer.recordAcceptedRotation(headId, { finality: 'accepted', predecessor, successor: head }, grants.grants);
  }
  privateWrite(headFile, JSON.stringify({ headId, ownerPublicKey, payTo: addressForScript(sdk, head.scriptPublicKey) }));
  if (setup.command === 'init') privateWrite(path.join(dataDir, 'cloudflare-head.json'), JSON.stringify({
    headId, network: 'kaspa:testnet-10', ownerPublicKey, head, grants: grants.grants,
  }));
  fs.unlinkSync(pendingFile);
}

function privateWrite(file, value) {
  fs.writeFileSync(file, value, { mode: 0o600, flag: 'w' });
  fs.chmodSync(file, 0o600);
}
function privateRead(file) {
  const stat = fs.statSync(file);
  if (process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error(`Private file permissions must be 0600: ${file}`);
  return fs.readFileSync(file, 'utf8').trim();
}
function addressForScript(sdk, serialized) {
  const script = new sdk.ScriptPublicKey(parseInt(serialized.slice(0, 4), 16), serialized.slice(4));
  try {
    const address = sdk.addressFromScriptPublicKey(script, 'testnet-10');
    try { return address.toString(); } finally { address.free(); }
  }
  finally { script.free(); }
}
function refInput(utxo, covenantId) {
  return { previousOutpoint: utxo.outpoint, signatureScript: '', sequence: '0', computeBudget: 10,
    utxo: { amount: utxo.amount, scriptPublicKey: utxo.scriptPublicKey, blockDaaScore: '0', isCoinbase: false, covenantId } };
}
function reference(inputs, outputs) {
  const mass = calculateKaspaStorageMass({
    inputs: inputs.map((item) => ({ amount: item.utxo.amount, scriptPublicKey: item.utxo.scriptPublicKey, hasCovenant: !!item.utxo.covenantId })),
    outputs: outputs.map((item) => ({ amount: item.amount, scriptPublicKey: item.scriptPublicKey, hasCovenant: !!item.covenant })),
  });
  return { version: 1, inputs, outputs, lockTime: '0', subnetworkId: '00'.repeat(20), gas: '0', payload: '', mass: String(mass), estimatedSerializedSize: 0 };
}
function sign(transaction, index, key) {
  return Buffer.from(schnorr.sign(Buffer.from(transactionV1Sighash(transaction, index).digest, 'hex'), Buffer.from(key, 'hex'))).toString('hex');
}

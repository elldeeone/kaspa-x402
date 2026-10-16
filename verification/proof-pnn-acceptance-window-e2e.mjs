import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { KaspaPnnClient } from '@kaspa-x402/adapters';
import { createNodeBoundedPnnWebSocket } from '@kaspa-x402/adapters/pnn-node';
const out = process.argv[process.argv.indexOf('--out') + 1];
assert.ok(process.argv.includes('--out') && out);
const hash = byte => byte.repeat(64);
const origin = hash('1'), accepting = hash('2'), tip = hash('3'), laterTip = hash('8'), txid = hash('4'), covenantId = hash('5');
const header = h => ({ hash: h, blueScore: h === laterTip ? '300' : h === tip ? '200' : '100', daaScore: h === laterTip ? '300' : h === tip ? '200' : '100' });
const transaction = { id: txid, inputs: [{ previousOutpoint: { transactionId: hash('6'), index: 0 } }],
  outputs: [{ value: '120000000', scriptPublicKey: '000020' + hash('7') + 'ac',
    covenant: { covenantId, authorizingInput: 0 } }] };
const peer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise(r => peer.once('listening', r));
const requests = [];
let dagReads = 0;
peer.on('connection', ws => ws.on('message', raw => {
  const { id, method, params } = JSON.parse(raw.toString()); requests.push({ method, params });
  let result;
  if (method === 'getServerInfo') result = { networkId: 'testnet-10', isSynced: true };
  else if (method === 'getBlockDagInfo') result = { sink: ++dagReads === 1 ? tip : laterTip };
  else if (method === 'getBlock') result = { block: { header: header(params.hash),
    verboseData: { hash: params.hash, isChainBlock: true, selectedParentHash: origin } } };
  else if (method === 'getVirtualChainFromBlock') result = { removedChainBlockHashes: [],
    addedChainBlockHashes: [accepting, tip, laterTip], acceptedTransactionIds: [{ acceptingBlockHash: accepting, acceptedTransactionIds: [txid] }] };
  else if (method === 'getVirtualChainFromBlockV2') {
    if (params.minConfirmationCount < 199) {
      ws.send(JSON.stringify({ id, params: { unrelatedLaterTransactions: 'x'.repeat(4_259_841) } })); return;
    }
    const blocks = params.dataVerbosityLevel === 'Low' ? [accepting, tip] : [accepting];
    result = { removedChainBlockHashes: [], addedChainBlockHashes: blocks,
      chainBlockAcceptedTransactions: blocks.map(h => ({ chainBlockHeader: header(h),
        acceptedTransactions: h === accepting ? [transaction] : [] })) };
  } else throw Error('Unexpected RPC method ' + method);
  ws.send(JSON.stringify({ id, params: result }));
}));
const client = new KaspaPnnClient({ endpoints: [`ws://127.0.0.1:${peer.address().port}/wrpc/json`],
  allowInsecureLoopback: true, boundedWebSocketFactory: createNodeBoundedPnnWebSocket, attempts: 1 });
let report;
try {
  const payment = await client.findHashChainPayment(txid, { blockHash: origin, blueScore: '99', daaScore: '99' });
  assert.equal(payment.transaction.successor.amount, '120000000');
  assert.equal(payment.evidence.confirmationCount, 2, 'depth must still use selected-parent positions');
  const accepted = await client.findAcceptedTransaction(txid, { from: { blockHash: origin, blueScore: '99', daaScore: '99' } });
  assert.equal(accepted.evidence.transactionId, txid);
  const verified = await client.confirmAcceptedTransaction(payment.evidence, 2);
  assert.equal(verified.confirmationCount, 3);
  const rich = requests.filter(r => r.method === 'getVirtualChainFromBlockV2' && r.params.dataVerbosityLevel !== 'Low');
  assert.equal(rich.length, 2);
  assert.ok(rich.every(r => r.params.minConfirmationCount === 199));
  report = { ok: true, transport: 'actual bounded Node WebSocket', maxMessageBytes: 4_259_840,
    hashChainAccepted: true, nativeAccepted: true, selectedParentDepth: 2,
    fullDataRangeFilter: 199, requests };
} catch (error) { report = { ok: false, error: error.message, requests }; }
finally {
  for (const ws of peer.clients) ws.terminate();
  await new Promise(r => peer.close(r));
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ ok: report.ok, error: report.error }));
if (!report.ok) process.exitCode = 1;

// Deterministic protocol boundary checks; no network, keys, or funds required.
// Run after npm run build: node scripts/check-adversarial-inputs.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as c from '@kaspa-x402/core';

const seed = 0x4022026;
let state = seed;
const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
const counts = {};
function check(group, name, fn) {
  try { fn(); counts[group] = (counts[group] ?? 0) + 1; }
  catch (error) { throw new Error(`seed=0x${seed.toString(16)} case=${group}/${name}`, { cause: error }); }
}
const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`../vectors/${name}.json`, import.meta.url)));
const exact = fixture('x402-http/exact-transaction');
const batch = fixture('x402-http/batch-voucher');
const encoded = (value) => Buffer.from(JSON.stringify(value)).toString('base64');

// Independent bigint oracle around every decimal prefix and uint64/int64 edges.
const amounts = new Set(['0', '1', ...['9223372036854775807', '18446744073709551615'].flatMap(max => {
  const values = [];
  for (let digits = 0; digits <= max.length; digits++) {
    const n = BigInt(max.slice(0, digits) || '0') * 10n ** BigInt(max.length - digits);
    for (let offset = -2n; offset <= 2n; offset++) values.push(String(n + offset));
  }
  return values;
})]);
for (let i = 0; i < 512; i++) amounts.add(String((BigInt(random()) << 32n) | BigInt(random())));
for (const amount of amounts) check('amounts', amount, () => {
  const n = BigInt(amount);
  const u64 = n >= 0 && n <= c.U64_MAX;
  assert.equal(c.isDecimalSompi(amount), u64);
  assert.equal(c.BATCH_AMOUNT_DECIMAL_PATTERN.test(amount), n >= 0 && n <= c.BATCH_SCRIPT_INT_MAX);
  if (u64) assert.equal(c.parseSompiString(amount), n);
  else assert.throws(() => c.parseSompiString(amount));
});
for (const amount of ['', '00', '01', '-0', '+1', '1.0', '1e3', ' 1', '1 ', '١', '１', '1\n', 'NaN', null, 1, {}, '9'.repeat(1024)])
  check('amount-invalid', String(amount), () => assert.throws(() => c.parseSompiString(amount)));

const readers = [
  ['required', c.decodePaymentRequiredHeader, exact.paymentRequired],
  ['envelope', c.decodePaymentRequiredEnvelopeHeader, exact.paymentRequired],
  ['payload', c.decodePaymentSignatureHeader, exact.paymentPayload],
  ['response', c.decodePaymentResponseHeader, exact.settlementResponse],
];
for (const [name, read, value] of readers) {
  check('headers', `${name}/valid`, () => assert.deepEqual(read(encoded(value)), value));
  for (const text of ['', '{', 'null', '[]', 'true', '1', '{"x402Version":2,}', '\u0000', '{}{}', '"unterminated'])
    check('headers', `${name}/malformed/${JSON.stringify(text)}`, () => assert.throws(() => read(Buffer.from(text).toString('base64'))));
  for (const [kind, extension] of [
    ['bytes', 'x'.repeat(c.MAX_PAYMENT_REPRESENTATION_BYTES)],
    ['depth', Array.from({length: 40}).reduce(v => ({nested: v}), null)],
    ['nodes', Array(16384).fill(null)],
    ['keys', Object.fromEntries(Array.from({length:1025}, (_, i) => [String(i), null]))],
  ]) check('headers', `${name}/${kind}`, () => assert.throws(() => read(encoded({...value, extensions: {attack: extension}}))));
  // JSON.parse uses the last duplicate key. Assert its effective value is the
  // value hashed/validated; this implementation does not promise duplicate rejection.
  const key = name === 'response' ? 'network' : 'x402Version';
  const invalid = name === 'response' ? 'invalid-network' : 0;
  const text = JSON.stringify(value);
  check('duplicate-json', `${name}/invalid-last`, () => assert.throws(() => read(Buffer.from(`${text.slice(0,-1)},${JSON.stringify(key)}:${JSON.stringify(invalid)}}`).toString('base64'))));
  check('duplicate-json', `${name}/valid-last`, () => assert.deepEqual(read(Buffer.from(`{${JSON.stringify(key)}:${JSON.stringify(invalid)},${text.slice(1)}`).toString('base64')), value));
}

for (let i = 0; i < 256; i++) check('canonical-json', i, () => {
  const entries = Array.from({length: 1 + random() % 12}, (_, j) => [`key-${j}-${random()}`, [random(), `\u0000é${random()}`, null]]);
  const a = Object.fromEntries(entries), b = Object.fromEntries([...entries].reverse());
  assert.equal(c.stableStringify(a), c.stableStringify(b));
  assert.deepEqual(JSON.parse(c.stableStringify(a)), a);
});

for (const [name, path, digest] of [
  ['exact', 'exact/interop-v1', c.exactRequestAuthorizationDigest],
  ['batch', 'batch/interop-v2', c.batchRequestAuthorizationDigest],
]) {
  const auth = fixture(path).requestAuthorization;
  const verify = input => schnorr.verify(c.hexToBytes(auth.signature), c.hexToBytes(digest(input)), c.hexToBytes(auth.signerPublicKey));
  check('signed-bindings', `${name}/valid`, () => assert.equal(verify(auth.input), true));
  for (const [key, value] of Object.entries(auth.input)) {
    const replacement = typeof value === 'number' ? value + 1
      : /^[0-9a-f]{64}$/i.test(value) ? (value[0] === 'a' ? 'b' : 'a') + value.slice(1)
      : key === 'amount' ? String(BigInt(value) + 1n)
      : key === 'expiresAt' ? new Date(Date.parse(value) + 1).toISOString()
      : key === 'audience' ? value + '?other=1'
      : key === 'network' ? 'kaspa:other'
      : value + 'x';
    check('signed-bindings', `${name}/changed-${key}`, () => assert.equal(verify({...auth.input, [key]:replacement}), false));
    if (typeof value === 'string' && /^[0-9a-f]+$/i.test(value) && key !== 'amount')
      check('signed-bindings', `${name}/hex-case-${key}`, () => assert.equal(digest({...auth.input, [key]:value.toUpperCase()}), digest(auth.input)));
  }
}

const nowMs = Date.parse('2026-09-07T12:00:00Z');
for (const delta of [-1000, -1, 0, 1, 999, 1000, 1001]) check('expiry', delta, () => {
  const expiresAt = new Date(nowMs + delta).toISOString();
  const valid = delta > 0 && delta <= 1000;
  assert.equal(c.exactAuthorizationExpiryError({nowMs, maxTimeoutSeconds:1, authorizationExpiresAt:expiresAt}) === undefined, valid);
  if (valid) c.assertBatchAuthorizationExpiry({nowMs, maxTimeoutSeconds:1, expiresAt});
  else assert.throws(() => c.assertBatchAuthorizationExpiry({nowMs, maxTimeoutSeconds:1, expiresAt}));
});
for (const challengeDelta of [-1, 0, 1, 500, 999, 1000, 1001]) check('challenge-expiry', challengeDelta, () => {
  assert.equal(c.exactAuthorizationExpiryError({nowMs, maxTimeoutSeconds:1, authorizationExpiresAt:new Date(nowMs+500).toISOString(), challengeExpiresAt:new Date(nowMs+challengeDelta).toISOString()}) === undefined, challengeDelta >= 500);
});

const intent = {audience:'https://merchant.example/mcp', toolName:'paid', arguments:{body:'original'}, paymentIdentifier:'id-123'};
for (const [key, value] of Object.entries(intent)) check('mcp-intent-binding', key, () => {
  assert.notEqual(c.mcpToolCallIntentFingerprint(intent), c.mcpToolCallIntentFingerprint({...intent, [key]:typeof value === 'string' ? value+'other' : {body:'altered'}}));
});
for (const value of [exact, batch]) {
  check('retry-binding', `${value.paymentPayload.accepted.scheme}/valid`, () => assert.equal(c.validatePaymentRetry(value).ok, true));
  for (const [key, changed] of [['amount','1'], ['network','kaspa:mainnet'], ['scheme','other'], ['asset','OTHER']])
    check('retry-binding', `${value.paymentPayload.accepted.scheme}/${key}`, () => {
      const paymentPayload = structuredClone(value.paymentPayload);
      paymentPayload.accepted[key] = changed;
      assert.equal(c.validatePaymentRetry({paymentRequired:value.paymentRequired, paymentPayload}).ok, false);
    });
}
console.log(JSON.stringify({seed:`0x${seed.toString(16)}`, cases:Object.values(counts).reduce((a,b)=>a+b,0), groups:counts, scope:'Local exported core APIs and real Schnorr verification of fixture signatures; no network, consensus, or service-side-effect proof.'}, null, 2));

import { afterEach, describe, expect, it, vi } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { payToScriptHashScript, serializedScriptPublicKey } from "@kaspa-x402/covenant";
import {
  KaspaRestClient,
  NativeAddressCodec,
  NativeVoucherVerifier,
  RestExactTransactionVerifier,
  RestKaspaChainProvider,
  ScriptAddressBook,
} from "../src/adapters.js";
import { encodeScriptAddress, scriptPublicKeyForAddress } from "../src/kaspa-native.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("KaspaRestClient", () => {
  it("calls the default Worker fetch through globalThis", async () => {
    const { KaspaRestClient } = await import("../src/adapters.js");
    const calls: unknown[] = [];
    globalThis.fetch = vi.fn(function (this: unknown, input: RequestInfo | URL) {
      calls.push(this);
      expect(input.toString()).toBe("https://api.example.test/info/blockdag");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            networkName: "kaspa-testnet-10",
            virtualDaaScore: "123",
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    }) as typeof fetch;

    const health = await new KaspaRestClient("https://api.example.test").health();

    expect(health.virtualDaaScore).toBe("123");
    expect(calls).toEqual([globalThis]);
  });
});

describe("RestKaspaChainProvider", () => {
  const address = "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh";
  const scriptPublicKey = "000020bee817fbf708b7ad2b12530bcc99e285805ab64faeea22f6d31e2bbcb164edf9ac";
  const txid = "aa".repeat(32);
  const addressUtxosPath = `https://api.example.test/addresses/${encodeURIComponent(address)}/utxos`;

  it("returns funding evidence only from the current address UTXO set", async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = input.toString();
      requests.push(url);
      expect(url).toBe(addressUtxosPath);
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              outpoint: { transactionId: txid, index: 0 },
              utxoEntry: {
                amount: "1000",
                scriptPublicKey: { scriptPublicKey },
              },
            },
          ]),
          { headers: { "content-type": "application/json" } },
        ),
      );
    }) as typeof fetch;
    const book = new ScriptAddressBook();
    book.record(scriptPublicKey, address);

    const utxo = await new RestKaspaChainProvider(new KaspaRestClient("https://api.example.test", { fetch: fetchMock }), book, "100").getUtxo(
      { txid, index: 0 },
      "kaspa:testnet-10",
    );

    expect(utxo).toEqual({
      outpoint: { txid, index: 0 },
      amount: "1000",
      scriptPublicKey,
      finality: "accepted",
    });
    expect(requests).toEqual([addressUtxosPath]);
  });

  it("does not accept historical transaction outputs when the outpoint is no longer unspent", async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = input.toString();
      requests.push(url);
      if (url.includes("/transactions/")) {
        throw new Error("historical transaction lookup must not be used for funding verification");
      }
      expect(url).toBe(addressUtxosPath);
      return Promise.resolve(new Response(JSON.stringify([]), { headers: { "content-type": "application/json" } }));
    }) as typeof fetch;
    const book = new ScriptAddressBook();
    book.record(scriptPublicKey, address);

    const utxo = await new RestKaspaChainProvider(new KaspaRestClient("https://api.example.test", { fetch: fetchMock }), book, "100").getUtxo(
      { txid, index: 0 },
      "kaspa:testnet-10",
    );

    expect(utxo).toBeNull();
    expect(requests).toEqual([addressUtxosPath]);
  });

  it("submits exact transaction artifacts and waits for accepted transaction evidence", async () => {
    const exact = exactTransactionFixture();
    let lookupCount = 0;
    let submitted: unknown;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith(`https://api.example.test/transactions/${exact.txid}`)) {
        lookupCount += 1;
        if (lookupCount === 1) return new Response(JSON.stringify({ detail: "Transaction not found" }), { status: 404 });
        return Response.json(exact.restTransaction);
      }
      if (url === "https://api.example.test/transactions") {
        submitted = JSON.parse(String(init?.body));
        return Response.json({ transactionId: exact.txid });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    const result = await new RestKaspaChainProvider(
      new KaspaRestClient("https://api.example.test", { fetch: fetchMock, acceptancePollMs: 0, acceptanceTimeoutMs: 100 }),
      new ScriptAddressBook(),
      "100",
    ).sendTransaction(exact.artifact);

    expect(result).toEqual({ transactionId: exact.txid, finality: "accepted" });
    const body = submitted as { transaction: { version: number; inputs: unknown[]; outputs: unknown[] }; allowOrphan: boolean };
    expect(body.allowOrphan).toBe(false);
    expect(body.transaction.version).toBe(1);
    expect(body.transaction.inputs[0]).toMatchObject({
      previousOutpoint: { transactionId: exact.borrowTxid, index: 0 },
      computeBudget: 10,
    });
    expect(body.transaction.outputs[0]).toMatchObject({
      amount: "110000000",
      scriptPublicKey: { version: 0, scriptPublicKey: exact.borrowScriptPublicKey.slice(4) },
    });
  });
});

describe("RestExactTransactionVerifier", () => {
  it("verifies reservation-backed KIP-10 exact transaction artifacts", async () => {
    const exact = exactTransactionFixture();
    const verifier = new RestExactTransactionVerifier(
      new KaspaRestClient("https://api.example.test", {
        fetch: vi.fn(async () => new Response(JSON.stringify({ detail: "Transaction not found" }), { status: 404 })) as typeof fetch,
      }),
    );

    const verified = await verifier.verifyExactPayment({
      network: "kaspa:testnet-10",
      transaction: exact.artifact,
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      paymentOutputIndex: 1,
      amount: "20000000",
      payTo: exact.payTo,
      payToScriptPublicKey: exact.payToScriptPublicKey,
      requiredFinality: "accepted",
      reservation: exact.reservation,
    });

    expect(verified).toEqual({
      transactionId: exact.txid,
      paymentOutput: {
        amount: "20000000",
        scriptPublicKey: exact.payToScriptPublicKey,
        address: exact.payTo,
      },
    });
  });

  it("marks exact transaction artifacts accepted when REST transaction evidence matches", async () => {
    const exact = exactTransactionFixture();
    const verifier = new RestExactTransactionVerifier(
      new KaspaRestClient("https://api.example.test", {
        fetch: vi.fn(async () => Response.json(exact.restTransaction)) as typeof fetch,
      }),
    );

    const verified = await verifier.verifyExactPayment({
      network: "kaspa:testnet-10",
      transaction: exact.artifact,
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      paymentOutputIndex: 1,
      amount: "20000000",
      payTo: exact.payTo,
      payToScriptPublicKey: exact.payToScriptPublicKey,
      requiredFinality: "accepted",
      reservation: exact.reservation,
    });

    expect(verified.finality).toBe("accepted");
  });
});

describe("NativeAddressCodec", () => {
  it("encodes the configured testnet address as the standard pay-to-pubkey script", () => {
    const address = "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh";

    expect(scriptPublicKeyForAddress(address, "kaspa:testnet-10")).toBe(
      "000020bee817fbf708b7ad2b12530bcc99e285805ab64faeea22f6d31e2bbcb164edf9ac",
    );
  });

  it("encodes a standard script-hash public key as the upstream testnet address format", () => {
    const serializedScriptPublicKey = "0000aa202f26140ec42a61dc73b33ad8880ae5d713764d5830d3cc5809fc2b2eebc9d8aa87";

    expect(
      encodeScriptAddress({
        network: "kaspa:testnet-10",
        scriptPublicKey: {
          version: 0,
          script: serializedScriptPublicKey.slice(4),
        },
        serializedScriptPublicKey,
      }),
    ).toBe("kaspatest:pqhjv9qwcs4xrhrnkvad3zq2uht3xajdtqcd8nzcp87zkthte8v25dg8gv4tq");
  });

  it("records generated addresses for fallback UTXO lookups", () => {
    const book = new ScriptAddressBook();
    const codec = new NativeAddressCodec(book);

    const address = codec.encodeScriptAddress({
      network: "kaspa:testnet-10",
      scriptPublicKey: {
        version: 0,
        script: "aa202f26140ec42a61dc73b33ad8880ae5d713764d5830d3cc5809fc2b2eebc9d8aa87",
      },
      serializedScriptPublicKey: "0000aa202f26140ec42a61dc73b33ad8880ae5d713764d5830d3cc5809fc2b2eebc9d8aa87",
    });

    expect(book.addresses()).toEqual([address]);
  });

  it("rejects non-standard script public keys", () => {
    expect(() =>
      encodeScriptAddress({
        network: "kaspa:testnet-10",
        scriptPublicKey: {
          version: 0,
          script: "51",
        },
        serializedScriptPublicKey: "000051",
      }),
    ).toThrow("not a standard address script");
  });
});

describe("NativeVoucherVerifier", () => {
  it("verifies raw digest Schnorr voucher signatures", () => {
    const secretKey = Uint8Array.from([
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03,
    ]);
    const publicKey = Buffer.from(schnorr.getPublicKey(secretKey)).toString("hex");
    const digest = "21".repeat(32);
    const signature = Buffer.from(schnorr.sign(Buffer.from(digest, "hex"), secretKey, new Uint8Array(32))).toString("hex");

    expect(
      new NativeVoucherVerifier().verifyVoucher({
        channelId: "11".repeat(32),
        clientPublicKey: publicKey,
        digest,
        preimage: "22".repeat(32),
        voucher: { amount: "100", signature },
      }),
    ).toBe(true);
    expect(
      new NativeVoucherVerifier().verifyVoucher({
        channelId: "11".repeat(32),
        clientPublicKey: publicKey,
        digest: "22".repeat(32),
        preimage: "22".repeat(32),
        voucher: { amount: "100", signature },
      }),
    ).toBe(false);
  });

  it("rejects the old personal-message voucher signature scheme", () => {
    const secretKey = Uint8Array.from([
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04,
    ]);
    const publicKey = Buffer.from(schnorr.getPublicKey(secretKey)).toString("hex");
    const digest = "21".repeat(32);
    const oldSchemeHash = blake2b(new TextEncoder().encode(digest), {
      dkLen: 32,
      key: new TextEncoder().encode("PersonalMessageSigningHash"),
    });
    const signature = Buffer.from(schnorr.sign(oldSchemeHash, secretKey, new Uint8Array(32))).toString("hex");

    expect(
      new NativeVoucherVerifier().verifyVoucher({
        channelId: "11".repeat(32),
        clientPublicKey: publicKey,
        digest,
        preimage: "22".repeat(32),
        voucher: { amount: "100", signature },
      }),
    ).toBe(false);
  });
});

function exactTransactionFixture() {
  const payTo = "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh";
  const payToScriptPublicKey = scriptPublicKeyForAddress(payTo, "kaspa:testnet-10");
  const borrowRedeemScript = "51";
  const borrowScriptPublicKey = serializedScriptPublicKey(payToScriptHashScript(borrowRedeemScript)).toLowerCase();
  const txid = "11".repeat(32);
  const borrowTxid = "22".repeat(32);
  const fundingTxid = "33".repeat(32);
  const artifact = JSON.stringify({
    id: txid,
    version: 1,
    inputs: [
      {
        transactionId: borrowTxid,
        index: 0,
        sequence: "0",
        sigOpCount: 0,
        computeBudget: 10,
        signatureScript: "00",
        utxo: {
          amount: "100000000",
          scriptPublicKey: borrowScriptPublicKey,
        },
      },
      {
        transactionId: fundingTxid,
        index: 1,
        sequence: "0",
        sigOpCount: 0,
        computeBudget: 10,
        signatureScript: "51",
        utxo: {
          amount: "40000000",
          scriptPublicKey: payToScriptPublicKey,
        },
      },
    ],
    outputs: [
      {
        value: "110000000",
        scriptPublicKey: borrowScriptPublicKey,
      },
      {
        value: "20000000",
        scriptPublicKey: payToScriptPublicKey,
      },
    ],
    subnetworkId: "00".repeat(20),
    lockTime: "0",
    gas: "0",
    storageMass: "0",
    payload: "",
  });
  return {
    txid,
    borrowTxid,
    borrowScriptPublicKey,
    payTo,
    payToScriptPublicKey,
    artifact,
    reservation: {
      reservationId: "44".repeat(32),
      templateId: "kaspa-x402-kip10-additive-v1" as const,
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0" as const,
      borrowOutpoint: { txid: borrowTxid, index: 0 },
      borrowAmount: "100000000",
      borrowScriptPublicKey,
      borrowRedeemScript,
      additiveThresholdSompi: "10000000",
      paymentOutputIndex: 1,
    },
    restTransaction: {
      transaction_id: txid,
      version: 1,
      is_accepted: true,
      inputs: [
        {
          previous_outpoint_hash: borrowTxid,
          previous_outpoint_index: "0",
          signature_script: "00",
          sig_op_count: "0",
          compute_budget: 10,
        },
        {
          previous_outpoint_hash: fundingTxid,
          previous_outpoint_index: "1",
          signature_script: "51",
          sig_op_count: "0",
          compute_budget: 10,
        },
      ],
      outputs: [
        {
          index: 0,
          amount: "110000000",
          script_public_key: borrowScriptPublicKey.slice(4),
        },
        {
          index: 1,
          amount: "20000000",
          script_public_key: payToScriptPublicKey.slice(4),
        },
      ],
    },
  };
}

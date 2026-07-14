import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2.js";
import {
  buildKip10AdditiveBorrowSignatureScript,
  buildKip10AdditiveRedeemScript,
  payToScriptHashScript,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";
import {
  KaspaPnnClient,
  KaspaRestClient,
  NativeAddressCodec,
  NativeVoucherVerifier,
  RestExactTransactionVerifier,
  RestKaspaChainProvider,
  ScriptAddressBook,
} from "../src/adapters.js";
import { addressForScriptPublicKey, encodeScriptAddress, scriptPublicKeyForAddress } from "../src/kaspa-native.js";

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

describe("KaspaPnnClient", () => {
  it("submits exact artifacts through PNN and waits for accepted payment evidence", async () => {
    const exact = exactTransactionFixture();
    const book = new ScriptAddressBook();
    book.record(exact.payToScriptPublicKey, exact.payTo);
    const submitted: unknown[] = [];
    const rpcFactory = mockPnnRpcFactory(() => ({
      async connect() {},
      async disconnect() {},
      async getServerInfo() {
        return { networkId: "testnet-10", isSynced: true, virtualDaaScore: "507000000" };
      },
      async submitTransaction(request) {
        submitted.push(request);
        return { transactionId: exact.txid };
      },
      async getUtxosByAddresses(addresses) {
        expect(addresses).toEqual([exact.payTo]);
        return { entries: [pnnPaymentUtxo(exact)] };
      },
    }));

    const result = await new KaspaPnnClient({
      endpoints: ["wss://pnn-a.example.test/kaspa/testnet-10/wrpc/json"],
      timeoutMs: 50,
      attempts: 1,
      rpcFactory,
      sleep: async () => undefined,
    }).submitTransaction(exact.artifact, book);

    expect(result).toEqual({ transactionId: exact.txid, finality: "accepted" });
    expect(submitted).toHaveLength(1);
    const request = submitted[0] as { allowOrphan: boolean; transaction: { version: number; inputs: unknown[]; outputs: unknown[]; storageMass: number } };
    expect(request.allowOrphan).toBe(false);
    expect(request.transaction.version).toBe(1);
    expect(request.transaction.inputs[0]).toMatchObject({
      previousOutpoint: { transactionId: exact.borrowTxid, index: 0 },
      computeBudget: 10,
      signatureScript: buildKip10AdditiveBorrowSignatureScript(exact.reservation.borrowRedeemScript),
    });
    expect(request.transaction.outputs[0]).toMatchObject({
      value: 110000000,
      scriptPublicKey: exact.borrowScriptPublicKey,
    });
    expect(request.transaction.storageMass).toBe(0);
  });

  it("fails over to the next PNN endpoint", async () => {
    const exact = exactTransactionFixture();
    const book = new ScriptAddressBook();
    book.record(exact.payToScriptPublicKey, exact.payTo);
    const endpoints: string[] = [];
    const rpcFactory = mockPnnRpcFactory((endpoint) => {
      endpoints.push(endpoint);
      if (endpoint.includes("pnn-a")) {
        return {
          async connect() {
            throw new Error("first endpoint down");
          },
          async disconnect() {},
          async getServerInfo() {
            throw new Error("unreachable");
          },
          async submitTransaction() {
            throw new Error("unreachable");
          },
          async getUtxosByAddresses() {
            throw new Error("unreachable");
          },
        };
      }
      return {
        async connect() {},
        async disconnect() {},
        async getServerInfo() {
          return { networkId: "testnet-10", isSynced: true };
        },
        async submitTransaction() {
          return { transactionId: exact.txid };
        },
        async getUtxosByAddresses() {
          return { entries: [pnnPaymentUtxo(exact)] };
        },
      };
    });

    await expect(
      new KaspaPnnClient({
        endpoints: ["wss://pnn-a.example.test/kaspa/testnet-10/wrpc/json", "wss://pnn-b.example.test/kaspa/testnet-10/wrpc/json"],
        timeoutMs: 50,
        attempts: 1,
        rpcFactory,
        sleep: async () => undefined,
      }).submitTransaction(exact.artifact, book),
    ).resolves.toEqual({ transactionId: exact.txid, finality: "accepted" });
    expect(endpoints).toEqual(["wss://pnn-a.example.test/kaspa/testnet-10/wrpc/json", "wss://pnn-b.example.test/kaspa/testnet-10/wrpc/json"]);
  });

  it("waits for evidence when PNN reports the transaction was already accepted", async () => {
    const exact = exactTransactionFixture();
    const book = new ScriptAddressBook();
    book.record(exact.payToScriptPublicKey, exact.payTo);
    const rpcFactory = mockPnnRpcFactory(() => ({
      async connect() {},
      async disconnect() {},
      async getServerInfo() {
        return { networkId: "testnet-10", isSynced: true };
      },
      async submitTransaction() {
        throw new Error("transaction already accepted");
      },
      async getUtxosByAddresses() {
        return { entries: [pnnPaymentUtxo(exact)] };
      },
    }));

    await expect(
      new KaspaPnnClient({
        endpoints: ["wss://pnn-a.example.test/kaspa/testnet-10/wrpc/json"],
        timeoutMs: 50,
        attempts: 1,
        rpcFactory,
        sleep: async () => undefined,
      }).submitTransaction(exact.artifact, book),
    ).resolves.toEqual({ transactionId: exact.txid, finality: "accepted" });
  });

  it("rejects PNN endpoints on the wrong network", async () => {
    const rpcFactory = mockPnnRpcFactory(() => ({
      async connect() {},
      async disconnect() {},
      async getServerInfo() {
        return { networkId: "mainnet", isSynced: true };
      },
      async submitTransaction() {
        throw new Error("unreachable");
      },
      async getUtxosByAddresses() {
        throw new Error("unreachable");
      },
    }));

    await expect(
      new KaspaPnnClient({
        endpoints: ["wss://pnn-a.example.test/kaspa/testnet-10/wrpc/json"],
        timeoutMs: 50,
        attempts: 1,
        rpcFactory,
        sleep: async () => undefined,
      }).health(),
    ).rejects.toThrow("Kaspa PNN request failed");
  });
});

describe("RestExactTransactionVerifier", () => {
  it("verifies the Rust-consensus standard-native vector from trusted UTXOs and Schnorr signatures", async () => {
    const vector = JSON.parse(
      await fs.promises.readFile(
        fileURLToPath(new URL("../../../vectors/exact/consensus-profiles.json", import.meta.url).toString()),
        "utf8",
      ),
    ) as {
      expected: {
        standardNative: {
          amount: string;
          transactionId: string;
          transaction: {
            version: 0;
            inputs: Array<{
              previousOutpoint: { txid: string; index: number };
              signatureScript: string;
              sequence: string;
              sigOpCount: number;
              computeBudget: null;
              utxo: { amount: string; scriptPublicKey: string };
            }>;
            outputs: Array<{ amount: string; scriptPublicKey: string; covenant: null }>;
            lockTime: string;
            subnetworkId: string;
            gas: string;
            payload: string;
            storageMass: string;
          };
        };
      };
    };
    const standard = vector.expected.standardNative;
    const input = standard.transaction.inputs[0]!;
    const merchant = standard.transaction.outputs[0]!;
    const artifact = JSON.stringify({
      id: standard.transactionId,
      ...standard.transaction,
      inputs: standard.transaction.inputs.map(({ computeBudget: _computeBudget, previousOutpoint, ...entry }) => ({
        ...entry,
        previousOutpoint: { transactionId: previousOutpoint.txid, index: previousOutpoint.index },
      })),
      outputs: standard.transaction.outputs.map(({ amount, ...output }) => ({ ...output, value: amount })),
    });
    const safeArtifact = JSON.parse(artifact) as {
      id: string;
      version: number;
      inputs: Array<{
        previousOutpoint: { transactionId: string; index: number };
        signatureScript: string;
        sequence: string;
        sigOpCount: number;
      }>;
      outputs: Array<{ value: string; scriptPublicKey: string }>;
      lockTime: string;
      subnetworkId: string;
      gas: string;
      payload: string;
    };
    let candidateAccepted = false;
    let inputUnspent = true;
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = new URL(request.toString());
      if (url.pathname === `/transactions/${input.previousOutpoint.txid}`) {
        return Response.json({
          transaction_id: input.previousOutpoint.txid,
          is_accepted: true,
          outputs: [
            {
              index: input.previousOutpoint.index,
              amount: input.utxo.amount,
              script_public_key: input.utxo.scriptPublicKey.slice(4),
            },
          ],
        });
      }
      if (url.pathname.startsWith("/addresses/") && url.pathname.endsWith("/utxos")) {
        return Response.json(inputUnspent ? [
          {
            outpoint: { transactionId: input.previousOutpoint.txid, index: input.previousOutpoint.index },
            utxoEntry: {
              amount: input.utxo.amount,
              scriptPublicKey: { scriptPublicKey: input.utxo.scriptPublicKey.slice(4) },
            },
          },
        ] : []);
      }
      if (url.pathname === `/transactions/${standard.transactionId}`) {
        if (candidateAccepted) {
          return Response.json({
            transaction_id: safeArtifact.id,
            version: safeArtifact.version,
            lock_time: safeArtifact.lockTime,
            subnetwork_id: safeArtifact.subnetworkId,
            gas: safeArtifact.gas,
            payload: safeArtifact.payload,
            is_accepted: true,
            inputs: safeArtifact.inputs.map((entry) => ({
              previous_outpoint_hash: entry.previousOutpoint.transactionId,
              previous_outpoint_index: entry.previousOutpoint.index,
              signature_script: entry.signatureScript,
              sequence: entry.sequence,
              sig_op_count: entry.sigOpCount,
            })),
            outputs: safeArtifact.outputs.map((entry, index) => ({
              index,
              amount: entry.value,
              script_public_key: entry.scriptPublicKey.slice(4),
            })),
          });
        }
        return new Response(JSON.stringify({ detail: "Transaction not found" }), { status: 404 });
      }
      throw new Error(`unexpected REST request ${url.pathname}`);
    }) as typeof fetch;
    const verifier = new RestExactTransactionVerifier(new KaspaRestClient("https://api.example.test", { fetch: fetchMock }));
    const payTo = addressForScriptPublicKey(merchant.scriptPublicKey, "kaspa:testnet-10");
    const request = {
      network: "kaspa:testnet-10" as const,
      profile: "standard-native" as const,
      transaction: artifact,
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0" as const,
      paymentOutputIndex: 0,
      amount: standard.amount,
      payTo,
      payToScriptPublicKey: merchant.scriptPublicKey,
      requiredFinality: "accepted" as const,
    };

    await expect(verifier.verifyExactPayment(request)).resolves.toMatchObject({
      transactionId: standard.transactionId,
      paymentOutput: { amount: standard.amount, scriptPublicKey: merchant.scriptPublicKey, address: payTo },
    });

    const invalidSignature = JSON.parse(artifact) as { inputs: Array<{ signatureScript: string }> };
    const invalidSignatureBytes = Uint8Array.from(Buffer.from(invalidSignature.inputs[0]!.signatureScript, "hex"));
    invalidSignatureBytes[1] ^= 1;
    invalidSignature.inputs[0]!.signatureScript = Buffer.from(invalidSignatureBytes).toString("hex");
    await expect(verifier.verifyExactPayment({ ...request, transaction: JSON.stringify(invalidSignature) })).rejects.toThrow(
      "standard-native funding signature is invalid",
    );

    const forgedUtxo = JSON.parse(artifact) as { inputs: Array<{ utxo: { scriptPublicKey: string } }> };
    forgedUtxo.inputs[0]!.utxo.scriptPublicKey = `${forgedUtxo.inputs[0]!.utxo.scriptPublicKey.slice(0, -2)}00`;
    await expect(verifier.verifyExactPayment({ ...request, transaction: JSON.stringify(forgedUtxo) })).rejects.toThrow(
      "standard-native embedded UTXO evidence does not match trusted chain state",
    );

    const wrongStorageMass = JSON.parse(artifact) as { storageMass: string };
    wrongStorageMass.storageMass = "0";
    await expect(verifier.verifyExactPayment({ ...request, transaction: JSON.stringify(wrongStorageMass) })).rejects.toThrow(
      "standard-native transaction storage mass does not match contextual KIP-9 mass",
    );

    candidateAccepted = true;
    inputUnspent = false;
    await expect(verifier.verifyExactPayment(request)).resolves.toMatchObject({
      transactionId: standard.transactionId,
      finality: "accepted",
    });
  });

  it("verifies the committed KIP-10 exact HTTP vector", async () => {
    const vector = JSON.parse(
      await fs.promises.readFile(
        fileURLToPath(new URL("../../../vectors/x402-http/exact-transaction.json", import.meta.url).toString()),
        "utf8",
      ),
    ) as {
      paymentRequired: {
        accepts: Array<{
          amount: string;
          payTo: string;
          extra: {
            reservationId: string;
            templateId: "kaspa-x402-kip10-additive-v1";
            transactionEncoding: "kaspa-sdk-safe-json-v2.0.0";
            borrowOutpoint: { txid: string; index: number };
            borrowAmount: string;
            borrowScriptPublicKey: string;
            borrowRedeemScript: string;
            additiveThresholdSompi: string;
            paymentOutputIndex: number;
          };
        }>;
      };
      paymentPayload: {
        payload: {
          transaction: string;
          transactionEncoding: "kaspa-sdk-safe-json-v2.0.0";
          paymentOutputIndex: number;
        };
      };
    };
    const accepted = vector.paymentRequired.accepts[0]!;
    const artifact = JSON.parse(vector.paymentPayload.payload.transaction) as { id: string };
    const verifier = offlineExactVerifier();

    await expect(
      verifier.verifyExactPayment({
        network: "kaspa:testnet-10",
        profile: "additive",
        transaction: vector.paymentPayload.payload.transaction,
        transactionEncoding: vector.paymentPayload.payload.transactionEncoding,
        paymentOutputIndex: vector.paymentPayload.payload.paymentOutputIndex,
        amount: accepted.amount,
        payTo: accepted.payTo,
        payToScriptPublicKey: scriptPublicKeyForAddress(accepted.payTo, "kaspa:testnet-10"),
        requiredFinality: "accepted",
        reservation: accepted.extra,
      }),
    ).resolves.toMatchObject({
      transactionId: artifact.id,
      continuation: {
        outpoint: { txid: artifact.id, index: 0 },
        amount: "110000000",
        scriptPublicKey: accepted.extra.borrowScriptPublicKey,
      },
    });
  });

  it("verifies reservation-backed KIP-10 exact transaction artifacts", async () => {
    const exact = exactTransactionFixture();
    const verifier = new RestExactTransactionVerifier(
      new KaspaRestClient("https://api.example.test", {
        fetch: vi.fn(async () => new Response(JSON.stringify({ detail: "Transaction not found" }), { status: 404 })) as typeof fetch,
      }),
    );

    const verified = await verifier.verifyExactPayment({
      network: "kaspa:testnet-10",
      profile: "additive",
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
      continuation: {
        outpoint: { txid: exact.txid, index: 0 },
        amount: "110000000",
        scriptPublicKey: exact.reservation.borrowScriptPublicKey,
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
      profile: "additive",
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

  it("rejects non-canonical or mismatched KIP-10 reservation scripts", async () => {
    const exact = exactTransactionFixture();
    const verifier = offlineExactVerifier();

    await expect(
      verifier.verifyExactPayment(exactVerificationRequest(exact, { reservation: { ...exact.reservation, borrowRedeemScript: "51" } })),
    ).rejects.toThrow("canonical KIP-10 additive template");
    await expect(
      verifier.verifyExactPayment(
        exactVerificationRequest(exact, { reservation: { ...exact.reservation, additiveThresholdSompi: "10000001" } }),
      ),
    ).rejects.toThrow("script threshold does not match reservation");
  });

  it("rejects unsafe exact transaction envelopes before chain submission", async () => {
    const exact = exactTransactionFixture();
    const base = JSON.parse(exact.artifact) as Record<string, unknown>;
    const verifier = offlineExactVerifier();
    const variants: Array<[string, Record<string, unknown>, string]> = [
      ["legacy version", { ...base, version: 0 }, "version must be 1"],
      ["non-native subnetwork", { ...base, subnetworkId: "11".repeat(20) }, "native subnetwork"],
      ["nonzero gas", { ...base, gas: "1" }, "gas must be 0"],
      ["payload", { ...base, payload: "00" }, "payload must be empty"],
      ["lock time", { ...base, lockTime: "1" }, "lockTime must be 0"],
    ];

    for (const [label, artifact, message] of variants) {
      await expect(
        verifier.verifyExactPayment(exactVerificationRequest(exact, { transaction: JSON.stringify(artifact) })),
        label,
      ).rejects.toThrow(message);
    }
  });

  it("rejects ambiguous payments, excessive fees, and a non-borrower signature script", async () => {
    const exact = exactTransactionFixture();
    const verifier = offlineExactVerifier();
    const duplicate = JSON.parse(exact.artifact) as { inputs: Array<{ utxo: { amount: string } }>; outputs: unknown[] };
    duplicate.inputs[1]!.utxo.amount = "60000000";
    duplicate.outputs.push(duplicate.outputs[1]);
    await expect(
      verifier.verifyExactPayment(exactVerificationRequest(exact, { transaction: JSON.stringify(duplicate) })),
    ).rejects.toThrow("ambiguous duplicate payment output");

    const excessiveFee = JSON.parse(exact.artifact) as { inputs: Array<{ utxo: { amount: string } }> };
    excessiveFee.inputs[1]!.utxo.amount = "1000000000";
    await expect(
      verifier.verifyExactPayment(exactVerificationRequest(exact, { transaction: JSON.stringify(excessiveFee) })),
    ).rejects.toThrow("fee exceeds the configured maximum");

    const wrongBranch = JSON.parse(exact.artifact) as { inputs: Array<{ signatureScript: string }> };
    wrongBranch.inputs[0]!.signatureScript = "00";
    await expect(
      verifier.verifyExactPayment(exactVerificationRequest(exact, { transaction: JSON.stringify(wrongBranch) })),
    ).rejects.toThrow("canonical KIP-10 borrower branch");
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

type MockPnnRpc = {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getServerInfo(): Promise<{ networkId?: unknown; isSynced?: unknown; virtualDaaScore?: unknown }>;
  submitTransaction(request: { transaction: unknown; allowOrphan: boolean }): Promise<{ transactionId?: unknown }>;
  getUtxosByAddresses(addresses: string[]): Promise<{ entries?: unknown[] }>;
};

function mockPnnRpcFactory(factory: (endpoint: string) => MockPnnRpc) {
  return (endpoint: string) => factory(endpoint);
}

function pnnPaymentUtxo(exact: ReturnType<typeof exactTransactionFixture>) {
  return {
    outpoint: { transactionId: exact.txid, index: 1 },
    utxoEntry: {
      amount: "20000000",
      scriptPublicKey: exact.payToScriptPublicKey,
    },
  };
}

function exactTransactionFixture() {
  const payTo = "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh";
  const payToScriptPublicKey = scriptPublicKeyForAddress(payTo, "kaspa:testnet-10");
  const borrowRedeemScript = buildKip10AdditiveRedeemScript({ ownerPublicKey: "55".repeat(32), amount: "10000000" });
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
        signatureScript: buildKip10AdditiveBorrowSignatureScript(borrowRedeemScript),
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
          signature_script: buildKip10AdditiveBorrowSignatureScript(borrowRedeemScript),
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

function offlineExactVerifier(): RestExactTransactionVerifier {
  return new RestExactTransactionVerifier(
    new KaspaRestClient("https://api.example.test", {
      fetch: vi.fn(async () => new Response(JSON.stringify({ detail: "Transaction not found" }), { status: 404 })) as typeof fetch,
    }),
  );
}

function exactVerificationRequest(
  exact: ReturnType<typeof exactTransactionFixture>,
  overrides: Record<string, unknown> = {},
): Parameters<RestExactTransactionVerifier["verifyExactPayment"]>[0] {
  return {
    network: "kaspa:testnet-10",
    transaction: exact.artifact,
    transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
    paymentOutputIndex: 1,
    amount: "20000000",
    payTo: exact.payTo,
    payToScriptPublicKey: exact.payToScriptPublicKey,
    requiredFinality: "accepted",
    reservation: exact.reservation,
    ...overrides,
  } as Parameters<RestExactTransactionVerifier["verifyExactPayment"]>[0];
}

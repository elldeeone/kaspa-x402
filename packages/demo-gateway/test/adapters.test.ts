import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2.js";
import {
  buildKip10AdditiveBorrowSignatureScript,
  buildKip10AdditiveRedeemScript,
  calculateKaspaStorageMass,
  payToScriptHashScript,
  serializedScriptPublicKey,
  transactionV1CovenantId,
  transactionV1Id,
  type TxV1ReferenceTransaction,
} from "@kaspa-x402/covenant";
import {
  KaspaPnnClient,
  KaspaRestClient,
  NativeAddressCodec,
  NativeVoucherVerifier,
  RestExactHeadReconciler,
  RestExactTransactionVerifier,
  RestKaspaChainProvider,
  ScriptAddressBook,
} from "../src/adapters.js";
import {
  addressForScriptPublicKey,
  encodeScriptAddress,
  scriptPublicKeyForAddress,
} from "../src/kaspa-native.js";
import type { ExactHeadRecord, ServerChannelRecord } from "@kaspa-x402/server";
import { exactRequestAuthorizationDigest } from "@kaspa-x402/core";

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
    globalThis.fetch = vi.fn(function (
      this: unknown,
      input: RequestInfo | URL,
    ) {
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

    const health = await new KaspaRestClient(
      "https://api.example.test",
    ).health();

    expect(health.virtualDaaScore).toBe("123");
    expect(calls).toEqual([globalThis]);
  });

  it("bounds REST response bytes and address UTXO entries", async () => {
    const oversized = new KaspaRestClient("https://api.example.test", {
      maxResponseBytes: 32,
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              networkName: "kaspa-testnet-10",
              virtualDaaScore: "123",
            }),
          ),
      ) as typeof fetch,
    });
    await expect(oversized.health()).rejects.toThrow("exceeds 32 bytes");

    const entry = {
      outpoint: { transactionId: "aa".repeat(32), index: 0 },
      utxoEntry: {
        amount: "1000",
        scriptPublicKey: { scriptPublicKey: "20" + "bb".repeat(32) },
      },
    };
    const tooMany = new KaspaRestClient("https://api.example.test", {
      maxUtxosPerAddress: 1,
      fetch: vi.fn(async () => Response.json([entry, entry])) as typeof fetch,
    });
    await expect(tooMany.getUtxosForAddress("kaspatest:qtest")).rejects.toThrow(
      "exceeds 1 entries",
    );
  });
});

describe("RestKaspaChainProvider", () => {
  const address =
    "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh";
  const scriptPublicKey =
    "000020bee817fbf708b7ad2b12530bcc99e285805ab64faeea22f6d31e2bbcb164edf9ac";
  const txid = "aa".repeat(32);
  const authorizingTxid = "ab".repeat(32);
  const addressUtxosPath = `https://api.example.test/addresses/${encodeURIComponent(address)}/utxos`;

  it("reads one persisted current outpoint and enriches its covenant id", async () => {
    const covenantId = transactionV1CovenantId(
      { txid: authorizingTxid, index: 1 },
      [
        {
          index: 0,
          output: {
            amount: "1000",
            scriptPublicKey,
            covenant: null,
          },
        },
      ],
    );
    const requests: string[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = input.toString();
      requests.push(url);
      if (url.includes(`/transactions/${txid}`)) {
        return Promise.resolve(
          Response.json({
            transaction_id: txid,
            version: 1,
            is_accepted: true,
            inputs: [
              {
                previous_outpoint_hash: authorizingTxid,
                previous_outpoint_index: "1",
                covenant_id: null,
              },
            ],
            outputs: [
              {
                index: 0,
                amount: "1000",
                script_public_key: scriptPublicKey.slice(4),
                covenant_authorizing_input: 0,
                covenant_id: covenantId,
              },
            ],
          }),
        );
      }
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
    book.recordOutpoint({ txid, index: 0 }, scriptPublicKey, address);

    const utxo = await new RestKaspaChainProvider(
      new KaspaRestClient("https://api.example.test", { fetch: fetchMock }),
      book,
      "100",
    ).getUtxo({ txid, index: 0 }, "kaspa:testnet-10");

    expect(utxo).toEqual({
      outpoint: { txid, index: 0 },
      amount: "1000",
      scriptPublicKey,
      finality: "accepted",
      covenantId,
    });
    expect(requests).toEqual([
      addressUtxosPath,
      expect.stringContaining(`/transactions/${txid}`),
    ]);
  });

  it("does not accept historical transaction outputs when the outpoint is no longer unspent", async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = input.toString();
      requests.push(url);
      if (url.includes("/transactions/")) {
        throw new Error(
          "historical transaction lookup must not be used for funding verification",
        );
      }
      expect(url).toBe(addressUtxosPath);
      return Promise.resolve(
        new Response(JSON.stringify([]), {
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;
    const book = new ScriptAddressBook();
    book.recordOutpoint({ txid, index: 0 }, scriptPublicKey, address);

    const utxo = await new RestKaspaChainProvider(
      new KaspaRestClient("https://api.example.test", { fetch: fetchMock }),
      book,
      "100",
    ).getUtxo({ txid, index: 0 }, "kaspa:testnet-10");

    expect(utxo).toBeNull();
    expect(requests).toEqual([addressUtxosPath]);
  });

  it("resolves an unpersisted funding outpoint from its exact output script without scanning addresses", async () => {
    const covenantId = transactionV1CovenantId(
      { txid: authorizingTxid, index: 1 },
      [
        {
          index: 0,
          output: {
            amount: "1000",
            scriptPublicKey,
            covenant: null,
          },
        },
      ],
    );
    const requests: string[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = input.toString();
      requests.push(url);
      if (url.includes(`/transactions/${txid}`)) {
        return Promise.resolve(
          Response.json({
            transaction_id: txid,
            version: 1,
            is_accepted: true,
            inputs: [
              {
                previous_outpoint_hash: authorizingTxid,
                previous_outpoint_index: "1",
                covenant_id: null,
              },
            ],
            outputs: [
              {
                index: 0,
                amount: "1000",
                script_public_key: scriptPublicKey.slice(4),
                covenant_authorizing_input: 0,
                covenant_id: covenantId,
              },
            ],
          }),
        );
      }
      expect(url).toBe(addressUtxosPath);
      return Promise.resolve(
        Response.json([
          {
            outpoint: { transactionId: txid, index: 0 },
            utxoEntry: {
              amount: "1000",
              scriptPublicKey: { scriptPublicKey },
            },
          },
        ]),
      );
    }) as typeof fetch;
    const book = new ScriptAddressBook();
    book.record(scriptPublicKey, address);
    book.record("0000aa", "kaspatest:qother");

    const utxo = await new RestKaspaChainProvider(
      new KaspaRestClient("https://api.example.test", { fetch: fetchMock }),
      book,
      "100",
    ).getUtxo({ txid, index: 0 }, "kaspa:testnet-10");

    expect(utxo?.covenantId).toBe(covenantId);
    expect(requests).toEqual([
      expect.stringContaining(`/transactions/${txid}`),
      addressUtxosPath,
    ]);
  });

  it("recomputes trusted singleton covenant genesis evidence", async () => {
    const covenantId = transactionV1CovenantId(
      { txid: authorizingTxid, index: 1 },
      [
        {
          index: 0,
          output: { amount: "1000", scriptPublicKey, covenant: null },
        },
      ],
    );
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      expect(input.toString()).toContain(`/transactions/${txid}`);
      return Promise.resolve(
        Response.json({
          transaction_id: txid,
          version: 1,
          is_accepted: true,
          inputs: [
            {
              previous_outpoint_hash: authorizingTxid,
              previous_outpoint_index: 1,
              covenant_id: null,
            },
          ],
          outputs: [
            {
              index: 0,
              amount: "1000",
              script_public_key: scriptPublicKey.slice(4),
              covenant_authorizing_input: 0,
              covenant_id: covenantId,
            },
          ],
        }),
      );
    }) as typeof fetch;
    const provider = new RestKaspaChainProvider(
      new KaspaRestClient("https://api.example.test", { fetch: fetchMock }),
      new ScriptAddressBook(),
      "100",
    );

    await expect(
      provider.verifyCovenantGenesis({
        utxo: {
          outpoint: { txid, index: 0 },
          covenantId,
          amount: "1000",
          scriptPublicKey,
          finality: "accepted",
        },
        payment: {} as never,
      }),
    ).resolves.toEqual({
      covenantId,
      authorizingInput: { txid: authorizingTxid, index: 1 },
      genesisOutpoint: { txid, index: 0 },
      genesisScriptPublicKey: scriptPublicKey,
      genesisAmount: "1000",
      totalOutputCount: 1,
      authorizedOutputCount: 1,
    });
  });

  it("rejects covenant genesis with an extra unauthorized output", async () => {
    const covenantId = transactionV1CovenantId(
      { txid: authorizingTxid, index: 1 },
      [
        {
          index: 0,
          output: { amount: "1000", scriptPublicKey, covenant: null },
        },
      ],
    );
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        Response.json({
          transaction_id: txid,
          version: 1,
          is_accepted: true,
          inputs: [
            {
              previous_outpoint_hash: authorizingTxid,
              previous_outpoint_index: 1,
              covenant_id: null,
            },
          ],
          outputs: [
            {
              index: 0,
              amount: "1000",
              script_public_key: scriptPublicKey.slice(4),
              covenant_authorizing_input: 0,
              covenant_id: covenantId,
            },
            {
              index: 1,
              amount: "1",
              script_public_key: "51",
              covenant_id: null,
            },
          ],
        }),
      ),
    ) as typeof fetch;
    const provider = new RestKaspaChainProvider(
      new KaspaRestClient("https://api.example.test", { fetch: fetchMock }),
      new ScriptAddressBook(),
      "100",
    );

    await expect(
      provider.verifyCovenantGenesis({
        utxo: {
          outpoint: { txid, index: 0 },
          covenantId,
          amount: "1000",
          scriptPublicKey,
          finality: "accepted",
        },
        payment: {} as never,
      }),
    ).resolves.toBeNull();
  });

  it("returns structured proof for one accepted top-up successor", async () => {
    const covenantId = "bc".repeat(32);
    const previousOutpoint = { txid: "bd".repeat(32), index: 0 };
    const nextOutpoint = { txid: "be".repeat(32), index: 0 };
    const previous = batchChannel({
      covenantId,
      activeOutpoint: previousOutpoint,
      activeScriptPublicKey: scriptPublicKey,
      fundingAmount: "1000",
    });
    const next = batchChannel({
      covenantId,
      activeOutpoint: nextOutpoint,
      activeScriptPublicKey: scriptPublicKey,
      fundingAmount: "2000",
    });
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        Response.json({
          transaction_id: nextOutpoint.txid,
          version: 1,
          is_accepted: true,
          inputs: [
            {
              previous_outpoint_hash: previousOutpoint.txid,
              previous_outpoint_index: previousOutpoint.index,
              covenant_id: covenantId,
            },
            {
              previous_outpoint_hash: "bf".repeat(32),
              previous_outpoint_index: 1,
              covenant_id: null,
            },
          ],
          outputs: [
            {
              index: 0,
              amount: "2000",
              script_public_key: scriptPublicKey.slice(4),
              covenant_authorizing_input: 0,
              covenant_id: covenantId,
            },
          ],
        }),
      ),
    ) as typeof fetch;
    const provider = new RestKaspaChainProvider(
      new KaspaRestClient("https://api.example.test", { fetch: fetchMock }),
      new ScriptAddressBook(),
      "100",
    );

    await expect(
      provider.verifyTopUp({
        previous,
        next,
        utxo: {
          outpoint: nextOutpoint,
          covenantId,
          amount: "2000",
          scriptPublicKey,
          finality: "accepted",
        },
        payment: {} as never,
      }),
    ).resolves.toEqual({
      covenantId,
      spentOutpoint: previousOutpoint,
      successorOutpoint: nextOutpoint,
      successorScriptPublicKey: scriptPublicKey,
      successorAmount: "2000",
      authorizedSuccessorCount: 1,
    });
  });

  it("submits exact transaction artifacts and waits for accepted transaction evidence", async () => {
    const exact = exactTransactionFixture();
    let lookupCount = 0;
    let submitted: unknown;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (
          url.startsWith(`https://api.example.test/transactions/${exact.txid}`)
        ) {
          lookupCount += 1;
          if (lookupCount === 1)
            return new Response(
              JSON.stringify({ detail: "Transaction not found" }),
              { status: 404 },
            );
          return Response.json(exact.restTransaction);
        }
        if (url === "https://api.example.test/transactions") {
          submitted = JSON.parse(String(init?.body));
          return Response.json({ transactionId: exact.txid });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    ) as typeof fetch;

    const result = await new RestKaspaChainProvider(
      new KaspaRestClient("https://api.example.test", {
        fetch: fetchMock,
        acceptancePollMs: 0,
        acceptanceTimeoutMs: 100,
      }),
      new ScriptAddressBook(),
      "100",
    ).sendTransaction(exact.artifact);

    expect(result).toEqual({ transactionId: exact.txid, finality: "accepted" });
    const body = submitted as {
      transaction: { version: number; inputs: unknown[]; outputs: unknown[] };
      allowOrphan: boolean;
    };
    expect(body.allowOrphan).toBe(false);
    expect(body.transaction.version).toBe(1);
    expect(body.transaction.inputs[0]).toMatchObject({
      previousOutpoint: { transactionId: exact.headTxid, index: 0 },
      computeBudget: 10,
    });
    expect(body.transaction.outputs[0]).toMatchObject({
      amount: "120000000",
      scriptPublicKey: {
        version: 0,
        scriptPublicKey: exact.headScriptPublicKey.slice(4),
      },
    });
  });
});

describe("RestExactHeadReconciler", () => {
  it("proves an unchanged current head from the address UTXO set", async () => {
    const exact = exactTransactionFixture();
    const head = exactHeadFixture(exact);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/utxos")) {
        return Response.json([
          {
            outpoint: { transactionId: exact.headTxid, index: 0 },
            utxoEntry: {
              amount: "100000000",
              scriptPublicKey: {
                scriptPublicKey: exact.headScriptPublicKey.slice(4),
              },
            },
          },
        ]);
      }
      throw new Error(`unexpected REST request ${url.pathname}`);
    }) as typeof fetch;

    await expect(
      new RestExactHeadReconciler(
        new KaspaRestClient("https://api.example.test", { fetch: fetchMock }),
      ).reconcileExactHead(head),
    ).resolves.toEqual({
      status: "current",
      outpoint: { txid: exact.headTxid, index: 0 },
      amount: "100000000",
      scriptPublicKey: exact.headScriptPublicKey,
      finality: "accepted",
    });
  });

  it("proves an ordered accepted successor lineage ending at the current UTXO", async () => {
    const exact = exactTransactionFixture();
    const head = exactHeadFixture(exact);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/utxos")) {
        return Response.json([
          {
            outpoint: { transactionId: exact.txid, index: 0 },
            utxoEntry: {
              amount: "120000000",
              scriptPublicKey: {
                scriptPublicKey: exact.headScriptPublicKey.slice(4),
              },
            },
          },
        ]);
      }
      if (url.pathname === `/transactions/${exact.txid}`)
        return Response.json(exact.restTransaction);
      throw new Error(`unexpected REST request ${url.pathname}`);
    }) as typeof fetch;

    await expect(
      new RestExactHeadReconciler(
        new KaspaRestClient("https://api.example.test", { fetch: fetchMock }),
      ).reconcileExactHead(head, [exact.txid]),
    ).resolves.toEqual({
      status: "advanced",
      steps: [
        {
          transactionId: exact.txid,
          spentOutpoint: { txid: exact.headTxid, index: 0 },
          successor: {
            outpoint: { txid: exact.txid, index: 0 },
            amount: "120000000",
            scriptPublicKey: exact.headScriptPublicKey,
          },
          finality: "accepted",
        },
      ],
    });
  });

  it("does not infer lineage from an attacker output sent to the same address", async () => {
    const exact = exactTransactionFixture();
    const head = exactHeadFixture(exact);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/utxos")) return Response.json([]);
      if (url.pathname === `/transactions/${exact.txid}`) {
        return Response.json({
          ...exact.restTransaction,
          inputs: [
            {
              previous_outpoint_hash: "ff".repeat(32),
              previous_outpoint_index: 0,
            },
          ],
        });
      }
      throw new Error(`unexpected REST request ${url.pathname}`);
    }) as typeof fetch;

    await expect(
      new RestExactHeadReconciler(
        new KaspaRestClient("https://api.example.test", { fetch: fetchMock }),
      ).reconcileExactHead(head, [exact.txid]),
    ).resolves.toMatchObject({
      status: "unknown",
      reason:
        "candidate transaction does not prove the expected same-index successor",
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
        return {
          networkId: "testnet-10",
          isSynced: true,
          virtualDaaScore: "507000000",
        };
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
    const request = submitted[0] as {
      allowOrphan: boolean;
      transaction: {
        version: number;
        inputs: unknown[];
        outputs: unknown[];
        storageMass: number;
      };
    };
    expect(request.allowOrphan).toBe(false);
    expect(request.transaction.version).toBe(1);
    expect(request.transaction.inputs[0]).toMatchObject({
      previousOutpoint: { transactionId: exact.headTxid, index: 0 },
      computeBudget: 10,
      signatureScript: buildKip10AdditiveBorrowSignatureScript(
        exact.headRedeemScript,
      ),
    });
    expect(request.transaction.outputs[0]).toMatchObject({
      value: 120000000,
      scriptPublicKey: exact.headScriptPublicKey,
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
        endpoints: [
          "wss://pnn-a.example.test/kaspa/testnet-10/wrpc/json",
          "wss://pnn-b.example.test/kaspa/testnet-10/wrpc/json",
        ],
        timeoutMs: 50,
        attempts: 1,
        rpcFactory,
        sleep: async () => undefined,
      }).submitTransaction(exact.artifact, book),
    ).resolves.toEqual({ transactionId: exact.txid, finality: "accepted" });
    expect(endpoints).toEqual([
      "wss://pnn-a.example.test/kaspa/testnet-10/wrpc/json",
      "wss://pnn-b.example.test/kaspa/testnet-10/wrpc/json",
    ]);
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
        fileURLToPath(
          new URL(
            "../../../vectors/exact/consensus-profiles.json",
            import.meta.url,
          ).toString(),
        ),
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
            outputs: Array<{
              amount: string;
              scriptPublicKey: string;
              covenant: null;
            }>;
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
      inputs: standard.transaction.inputs.map(
        ({ computeBudget: _computeBudget, previousOutpoint, ...entry }) => ({
          ...entry,
          previousOutpoint: {
            transactionId: previousOutpoint.txid,
            index: previousOutpoint.index,
          },
        }),
      ),
      outputs: standard.transaction.outputs.map(({ amount, ...output }) => ({
        ...output,
        value: amount,
      })),
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
    let acceptedComputeBudget: number | null | "absent" = "absent";
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
      if (
        url.pathname.startsWith("/addresses/") &&
        url.pathname.endsWith("/utxos")
      ) {
        return Response.json(
          inputUnspent
            ? [
                {
                  outpoint: {
                    transactionId: input.previousOutpoint.txid,
                    index: input.previousOutpoint.index,
                  },
                  utxoEntry: {
                    amount: input.utxo.amount,
                    scriptPublicKey: {
                      scriptPublicKey: input.utxo.scriptPublicKey.slice(4),
                    },
                  },
                },
              ]
            : [],
        );
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
              ...(acceptedComputeBudget === "absent"
                ? {}
                : { compute_budget: acceptedComputeBudget }),
            })),
            outputs: safeArtifact.outputs.map((entry, index) => ({
              index,
              amount: entry.value,
              script_public_key: entry.scriptPublicKey.slice(4),
            })),
          });
        }
        return new Response(
          JSON.stringify({ detail: "Transaction not found" }),
          { status: 404 },
        );
      }
      throw new Error(`unexpected REST request ${url.pathname}`);
    });
    const verifier = new RestExactTransactionVerifier(
      new KaspaRestClient("https://api.example.test", {
        fetch: fetchMock as typeof fetch,
      }),
    );
    const payTo = addressForScriptPublicKey(
      merchant.scriptPublicKey,
      "kaspa:testnet-10",
    );
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
      ...exactAuthorizationFields({
        profile: "standard-native",
        transactionId: standard.transactionId,
        paymentOutputIndex: 0,
        amount: standard.amount,
        payTo,
        payToScriptPublicKey: merchant.scriptPublicKey,
        inputIndex: 0,
      }),
    };

    await expect(verifier.verifyExactPayment(request)).resolves.toMatchObject({
      transactionId: standard.transactionId,
      paymentOutput: {
        amount: standard.amount,
        scriptPublicKey: merchant.scriptPublicKey,
        address: payTo,
      },
    });

    const sdkSafeArtifact = JSON.parse(artifact) as {
      inputs: Array<{ computeBudget?: number }>;
    };
    sdkSafeArtifact.inputs[0]!.computeBudget = 0;
    await expect(
      verifier.verifyExactPayment({
        ...request,
        transaction: JSON.stringify(sdkSafeArtifact),
      }),
    ).resolves.toMatchObject({ transactionId: standard.transactionId });

    sdkSafeArtifact.inputs[0]!.computeBudget = 1;
    await expect(
      verifier.verifyExactPayment({
        ...request,
        transaction: JSON.stringify(sdkSafeArtifact),
      }),
    ).rejects.toThrow("cannot carry a non-zero compute budget");

    const duplicateInput = JSON.parse(artifact) as {
      inputs: Array<Record<string, unknown>>;
    };
    duplicateInput.inputs.push(structuredClone(duplicateInput.inputs[0]!));
    const readsBeforeDuplicate = fetchMock.mock.calls.length;
    await expect(
      verifier.verifyExactPayment({
        ...request,
        transaction: JSON.stringify(duplicateInput),
      }),
    ).rejects.toThrow("duplicate input outpoint");
    expect(fetchMock).toHaveBeenCalledTimes(readsBeforeDuplicate);

    const excessiveInputs = JSON.parse(artifact) as {
      inputs: Array<{
        previousOutpoint: { transactionId: string; index: number };
      }>;
    };
    excessiveInputs.inputs = Array.from({ length: 17 }, (_, index) => ({
      ...structuredClone(excessiveInputs.inputs[0]!),
      previousOutpoint: {
        transactionId: index.toString(16).padStart(64, "0"),
        index,
      },
    }));
    await expect(
      verifier.verifyExactPayment({
        ...request,
        transaction: JSON.stringify(excessiveInputs),
      }),
    ).rejects.toThrow("too many inputs");
    expect(fetchMock).toHaveBeenCalledTimes(readsBeforeDuplicate);

    await expect(
      verifier.verifyExactPayment({
        ...request,
        requestHash: "94".repeat(32),
      }),
    ).rejects.toThrow("request authorization signature is invalid");
    await expect(
      verifier.verifyExactPayment({
        ...request,
        paymentRequirementsHash: "95".repeat(32),
      }),
    ).rejects.toThrow("request authorization signature is invalid");

    const readsBeforeInvalidSignature = fetchMock.mock.calls.length;
    const invalidSignature = JSON.parse(artifact) as {
      inputs: Array<{ signatureScript: string }>;
    };
    const invalidSignatureBytes = Uint8Array.from(
      Buffer.from(invalidSignature.inputs[0]!.signatureScript, "hex"),
    );
    invalidSignatureBytes[1] ^= 1;
    invalidSignature.inputs[0]!.signatureScript = Buffer.from(
      invalidSignatureBytes,
    ).toString("hex");
    await expect(
      verifier.verifyExactPayment({
        ...request,
        transaction: JSON.stringify(invalidSignature),
      }),
    ).rejects.toThrow("standard-native funding signature is invalid");
    expect(fetchMock).toHaveBeenCalledTimes(readsBeforeInvalidSignature);

    const forgedUtxo = JSON.parse(artifact) as {
      inputs: Array<{ utxo: { scriptPublicKey: string } }>;
    };
    forgedUtxo.inputs[0]!.utxo.scriptPublicKey = `${forgedUtxo.inputs[0]!.utxo.scriptPublicKey.slice(0, -2)}00`;
    await expect(
      verifier.verifyExactPayment({
        ...request,
        transaction: JSON.stringify(forgedUtxo),
      }),
    ).rejects.toThrow(
      "standard-native funding input must be a version-0 Schnorr P2PK script",
    );

    const wrongStorageMass = JSON.parse(artifact) as { storageMass: string };
    wrongStorageMass.storageMass = "0";
    await expect(
      verifier.verifyExactPayment({
        ...request,
        transaction: JSON.stringify(wrongStorageMass),
      }),
    ).rejects.toThrow(
      "standard-native transaction storage mass does not match contextual KIP-9 mass",
    );

    candidateAccepted = true;
    inputUnspent = false;
    await expect(verifier.verifyExactPayment(request)).resolves.toMatchObject({
      transactionId: standard.transactionId,
      finality: "accepted",
    });

    sdkSafeArtifact.inputs[0]!.computeBudget = 0;
    acceptedComputeBudget = "absent";
    await expect(
      verifier.verifyExactPayment({
        ...request,
        transaction: JSON.stringify(sdkSafeArtifact),
      }),
    ).resolves.toMatchObject({ transactionId: standard.transactionId });

    acceptedComputeBudget = null;
    await expect(
      verifier.verifyExactPayment({
        ...request,
        transaction: JSON.stringify(sdkSafeArtifact),
      }),
    ).resolves.toMatchObject({ transactionId: standard.transactionId });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2100-01-01T00:00:00.000Z"));
    try {
      await expect(verifier.verifyExactPayment(request)).rejects.toThrow(
        "exact request authorization has expired",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("verifies the corrected additive vector as an exact head delta without a second merchant output", async () => {
    const vector = JSON.parse(
      await fs.promises.readFile(
        fileURLToPath(
          new URL(
            "../../../vectors/exact/consensus-profiles.json",
            import.meta.url,
          ).toString(),
        ),
        "utf8",
      ),
    ) as {
      expected: {
        additive: {
          amount: string;
          transactionId: string;
          transaction: {
            version: 1;
            inputs: Array<{
              previousOutpoint: { txid: string; index: number };
              signatureScript: string;
              sequence: string;
              computeBudget: number;
              utxo: { amount: string; scriptPublicKey: string };
            }>;
            outputs: Array<{
              amount: string;
              scriptPublicKey: string;
              covenant: null;
            }>;
            lockTime: string;
            subnetworkId: string;
            gas: string;
            payload: string;
            storageMass: string;
          };
        };
      };
    };
    const additive = vector.expected.additive;
    const artifactObject: AdditiveSafeArtifact = {
      id: additive.transactionId,
      ...additive.transaction,
      inputs: additive.transaction.inputs.map(
        ({ previousOutpoint, ...entry }) => ({
          ...entry,
          previousOutpoint: {
            transactionId: previousOutpoint.txid,
            index: previousOutpoint.index,
          },
          sigOpCount: 0,
        }),
      ),
      outputs: additive.transaction.outputs.map(({ amount, ...output }) => ({
        ...output,
        value: amount,
      })),
    };
    const artifact = JSON.stringify(artifactObject);
    let candidateAccepted = false;
    let includeAcceptedComputeBudget = true;
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = new URL(request.toString());
      const input = additive.transaction.inputs.find(
        (candidate) =>
          url.pathname === `/transactions/${candidate.previousOutpoint.txid}`,
      );
      if (input) {
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
      if (
        candidateAccepted &&
        url.pathname === `/transactions/${additive.transactionId}`
      ) {
        return Response.json({
          transaction_id: artifactObject.id,
          version: artifactObject.version,
          lock_time: artifactObject.lockTime,
          subnetwork_id: artifactObject.subnetworkId,
          gas: artifactObject.gas,
          payload: artifactObject.payload,
          is_accepted: true,
          inputs: artifactObject.inputs.map((entry) => ({
            previous_outpoint_hash: entry.previousOutpoint.transactionId,
            previous_outpoint_index: entry.previousOutpoint.index,
            signature_script: entry.signatureScript,
            sequence: entry.sequence,
            sig_op_count: entry.sigOpCount,
            ...(includeAcceptedComputeBudget
              ? { compute_budget: entry.computeBudget }
              : {}),
          })),
          outputs: artifactObject.outputs.map((entry, index) => ({
            index,
            amount: entry.value,
            script_public_key: entry.scriptPublicKey.slice(4),
          })),
        });
      }
      if (url.pathname.startsWith("/transactions/")) {
        return new Response(
          JSON.stringify({ detail: "Transaction not found" }),
          { status: 404 },
        );
      }
      if (
        url.pathname.startsWith("/addresses/") &&
        url.pathname.endsWith("/utxos")
      ) {
        const address = decodeURIComponent(
          url.pathname.slice("/addresses/".length, -"/utxos".length),
        );
        const matched = additive.transaction.inputs.find(
          (candidate) =>
            addressForScriptPublicKey(
              candidate.utxo.scriptPublicKey,
              "kaspa:testnet-10",
            ) === address,
        );
        if (!matched) throw new Error(`unexpected UTXO address ${address}`);
        return Response.json([
          {
            outpoint: {
              transactionId: matched.previousOutpoint.txid,
              index: matched.previousOutpoint.index,
            },
            utxoEntry: {
              amount: matched.utxo.amount,
              scriptPublicKey: {
                scriptPublicKey: matched.utxo.scriptPublicKey.slice(4),
              },
            },
          },
        ]);
      }
      throw new Error(`unexpected REST request ${url.pathname}`);
    }) as typeof fetch;
    const verifier = new RestExactTransactionVerifier(
      new KaspaRestClient("https://api.example.test", { fetch: fetchMock }),
    );
    const headInput = additive.transaction.inputs[0]!;
    const redeemScript = headInput.signatureScript.slice(4);
    const payTo = addressForScriptPublicKey(
      headInput.utxo.scriptPublicKey,
      "kaspa:testnet-10",
    );

    await expect(
      verifier.verifyExactPayment({
        network: "kaspa:testnet-10",
        profile: "additive",
        transaction: artifact,
        transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
        paymentOutputIndex: 0,
        amount: additive.amount,
        payTo,
        payToScriptPublicKey: headInput.utxo.scriptPublicKey,
        requiredFinality: "accepted",
        ...exactAuthorizationFields({
          profile: "additive",
          transactionId: additive.transactionId,
          paymentOutputIndex: 0,
          amount: additive.amount,
          payTo,
          payToScriptPublicKey: headInput.utxo.scriptPublicKey,
          challengeId: "91".repeat(32),
          inputIndex: 1,
        }),
        head: {
          headId: "90".repeat(32),
          headVersion: "0",
          templateId: "kaspa-x402-kip10-additive-v1",
          transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
          expectedHeadOutpoint: headInput.previousOutpoint,
          headAmount: headInput.utxo.amount,
          headScriptPublicKey: headInput.utxo.scriptPublicKey,
          headRedeemScript: redeemScript,
          additiveThresholdSompi: "10000000",
          paymentOutputIndex: 0,
          challengeId: "91".repeat(32),
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      }),
    ).resolves.toMatchObject({
      transactionId: additive.transactionId,
      paymentOutput: {
        amount: additive.amount,
        scriptPublicKey: headInput.utxo.scriptPublicKey,
        address: payTo,
      },
      continuation: {
        outpoint: { txid: additive.transactionId, index: 0 },
        amount: additive.transaction.outputs[0]!.amount,
        scriptPublicKey: headInput.utxo.scriptPublicKey,
      },
    });
    expect(
      additive.transaction.outputs.filter(
        (output) => output.scriptPublicKey === headInput.utxo.scriptPublicKey,
      ),
    ).toHaveLength(1);

    const request = {
      network: "kaspa:testnet-10",
      profile: "additive",
      transaction: artifact,
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      paymentOutputIndex: 0,
      amount: additive.amount,
      payTo,
      payToScriptPublicKey: headInput.utxo.scriptPublicKey,
      requiredFinality: "accepted",
      ...exactAuthorizationFields({
        profile: "additive",
        transactionId: additive.transactionId,
        paymentOutputIndex: 0,
        amount: additive.amount,
        payTo,
        payToScriptPublicKey: headInput.utxo.scriptPublicKey,
        challengeId: "91".repeat(32),
        inputIndex: 1,
      }),
      head: {
        headId: "90".repeat(32),
        headVersion: "0",
        templateId: "kaspa-x402-kip10-additive-v1",
        transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
        expectedHeadOutpoint: headInput.previousOutpoint,
        headAmount: headInput.utxo.amount,
        headScriptPublicKey: headInput.utxo.scriptPublicKey,
        headRedeemScript: redeemScript,
        additiveThresholdSompi: "10000000",
        paymentOutputIndex: 0,
        challengeId: "91".repeat(32),
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    } as const;

    const excessiveDelta = structuredClone(artifactObject);
    excessiveDelta.outputs[0]!.value = (
      BigInt(excessiveDelta.outputs[0]!.value) + 1n
    ).toString();
    excessiveDelta.outputs[1]!.value = (
      BigInt(excessiveDelta.outputs[1]!.value) - 1n
    ).toString();
    refreshAdditiveArtifact(excessiveDelta);
    await expect(
      verifier.verifyExactPayment({
        ...request,
        transaction: JSON.stringify(excessiveDelta),
      }),
    ).rejects.toThrow("successor delta must equal the advertised amount");

    const duplicateMerchantBenefit = structuredClone(artifactObject);
    duplicateMerchantBenefit.outputs.push({
      value: "1",
      scriptPublicKey: headInput.utxo.scriptPublicKey,
      covenant: null,
    });
    await expect(
      verifier.verifyExactPayment({
        ...request,
        transaction: JSON.stringify(duplicateMerchantBenefit),
      }),
    ).rejects.toThrow("permits only the successor and optional payer change");

    const overbudget = structuredClone(artifactObject);
    overbudget.inputs[0]!.computeBudget = 1;
    await expect(
      verifier.verifyExactPayment({
        ...request,
        transaction: JSON.stringify(overbudget),
      }),
    ).rejects.toThrow("input 0 compute budget must be 0");

    const wrongMass = structuredClone(artifactObject);
    wrongMass.storageMass = (BigInt(wrongMass.storageMass) + 1n).toString();
    await expect(
      verifier.verifyExactPayment({
        ...request,
        transaction: JSON.stringify(wrongMass),
      }),
    ).rejects.toThrow("storage mass does not match contextual KIP-9 mass");

    const forgedUtxo = structuredClone(artifactObject);
    forgedUtxo.inputs[1]!.utxo.amount = (
      BigInt(forgedUtxo.inputs[1]!.utxo.amount) + 1n
    ).toString();
    refreshAdditiveArtifact(forgedUtxo);
    await expect(
      verifier.verifyExactPayment({
        ...request,
        transaction: JSON.stringify(forgedUtxo),
      }),
    ).rejects.toThrow("additive exact payer signature is invalid");

    const invalidSignature = structuredClone(artifactObject);
    const signature = Uint8Array.from(
      Buffer.from(invalidSignature.inputs[1]!.signatureScript, "hex"),
    );
    signature[1] ^= 1;
    invalidSignature.inputs[1]!.signatureScript =
      Buffer.from(signature).toString("hex");
    await expect(
      verifier.verifyExactPayment({
        ...request,
        transaction: JSON.stringify(invalidSignature),
      }),
    ).rejects.toThrow("payer signature is invalid");

    candidateAccepted = true;
    await expect(verifier.verifyExactPayment(request)).resolves.toMatchObject({
      transactionId: additive.transactionId,
      finality: "accepted",
    });

    includeAcceptedComputeBudget = false;
    await expect(verifier.verifyExactPayment(request)).rejects.toThrow(
      "accepted transaction computeBudget does not match exact artifact",
    );
    includeAcceptedComputeBudget = true;

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2100-01-01T00:00:00.000Z"));
    try {
      await expect(verifier.verifyExactPayment(request)).rejects.toThrow(
        "exact request authorization has expired",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("NativeAddressCodec", () => {
  it("encodes the configured testnet address as the standard pay-to-pubkey script", () => {
    const address =
      "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh";

    expect(scriptPublicKeyForAddress(address, "kaspa:testnet-10")).toBe(
      "000020bee817fbf708b7ad2b12530bcc99e285805ab64faeea22f6d31e2bbcb164edf9ac",
    );
  });

  it("encodes a standard script-hash public key as the upstream testnet address format", () => {
    const serializedScriptPublicKey =
      "0000aa202f26140ec42a61dc73b33ad8880ae5d713764d5830d3cc5809fc2b2eebc9d8aa87";

    expect(
      encodeScriptAddress({
        network: "kaspa:testnet-10",
        scriptPublicKey: {
          version: 0,
          script: serializedScriptPublicKey.slice(4),
        },
        serializedScriptPublicKey,
      }),
    ).toBe(
      "kaspatest:pqhjv9qwcs4xrhrnkvad3zq2uht3xajdtqcd8nzcp87zkthte8v25dg8gv4tq",
    );
  });

  it("records generated addresses for fallback UTXO lookups", () => {
    const book = new ScriptAddressBook();
    const codec = new NativeAddressCodec(book);

    const address = codec.encodeScriptAddress({
      network: "kaspa:testnet-10",
      scriptPublicKey: {
        version: 0,
        script:
          "aa202f26140ec42a61dc73b33ad8880ae5d713764d5830d3cc5809fc2b2eebc9d8aa87",
      },
      serializedScriptPublicKey:
        "0000aa202f26140ec42a61dc73b33ad8880ae5d713764d5830d3cc5809fc2b2eebc9d8aa87",
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
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03,
    ]);
    const publicKey = Buffer.from(schnorr.getPublicKey(secretKey)).toString(
      "hex",
    );
    const digest = "21".repeat(32);
    const signature = Buffer.from(
      schnorr.sign(Buffer.from(digest, "hex"), secretKey, new Uint8Array(32)),
    ).toString("hex");

    expect(
      new NativeVoucherVerifier().verifyVoucher({
        channelId: "11".repeat(32),
        clientPublicKey: publicKey,
        digest,
        preimage: "22".repeat(32),
        voucher: {
          covenantId: "23".repeat(32),
          amount: "100",
          signature,
        },
      }),
    ).toBe(true);
    expect(
      new NativeVoucherVerifier().verifyVoucher({
        channelId: "11".repeat(32),
        clientPublicKey: publicKey,
        digest: "22".repeat(32),
        preimage: "22".repeat(32),
        voucher: {
          covenantId: "23".repeat(32),
          amount: "100",
          signature,
        },
      }),
    ).toBe(false);
  });

  it("rejects the old personal-message voucher signature scheme", () => {
    const secretKey = Uint8Array.from([
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04,
    ]);
    const publicKey = Buffer.from(schnorr.getPublicKey(secretKey)).toString(
      "hex",
    );
    const digest = "21".repeat(32);
    const oldSchemeHash = blake2b(new TextEncoder().encode(digest), {
      dkLen: 32,
      key: new TextEncoder().encode("PersonalMessageSigningHash"),
    });
    const signature = Buffer.from(
      schnorr.sign(oldSchemeHash, secretKey, new Uint8Array(32)),
    ).toString("hex");

    expect(
      new NativeVoucherVerifier().verifyVoucher({
        channelId: "11".repeat(32),
        clientPublicKey: publicKey,
        digest,
        preimage: "22".repeat(32),
        voucher: {
          covenantId: "23".repeat(32),
          amount: "100",
          signature,
        },
      }),
    ).toBe(false);
  });
});

function batchChannel(
  overrides: Partial<ServerChannelRecord>,
): ServerChannelRecord {
  const covenantId = overrides.covenantId ?? "c0".repeat(32);
  const activeOutpoint = overrides.activeOutpoint ?? {
    txid: "c1".repeat(32),
    index: 0,
  };
  const activeScriptPublicKey =
    overrides.activeScriptPublicKey ?? `0000${"c2".repeat(34)}`;
  const fundingAmount = overrides.fundingAmount ?? "1000";
  return {
    channelId: "c3".repeat(32),
    covenantId,
    genesisEvidence: {
      covenantId,
      authorizingInput: { txid: "c4".repeat(32), index: 0 },
      genesisOutpoint: { txid: "c5".repeat(32), index: 0 },
      genesisScriptPublicKey: activeScriptPublicKey,
      genesisAmount: "1000",
      totalOutputCount: 1,
      authorizedOutputCount: 1,
    },
    channelConfig: {
      network: "kaspa:testnet-10",
      asset: "KAS",
      templateId: "kaspa-x402-escrow-v2",
      clientPublicKey: "c6".repeat(32),
      serverPublicKey: "c7".repeat(32),
      payTo: "kaspatest:payout",
      refundAddress: "kaspatest:refund",
      refundTimeoutDaa: "2000",
      salt: "c8".repeat(32),
    },
    escrowAddress: "kaspatest:escrow",
    activeOutpoint,
    activeScriptPublicKey,
    fundingAmount,
    chargedCumulativeAmount: "0",
    claimedCumulativeAmount: "0",
    signedMaxClaimable: "0",
    status: "active",
    ...overrides,
  };
}

type MockPnnRpc = {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getServerInfo(): Promise<{
    networkId?: unknown;
    isSynced?: unknown;
    virtualDaaScore?: unknown;
  }>;
  submitTransaction(request: {
    transaction: unknown;
    allowOrphan: boolean;
  }): Promise<{ transactionId?: unknown }>;
  getUtxosByAddresses(addresses: string[]): Promise<{ entries?: unknown[] }>;
};

function mockPnnRpcFactory(factory: (endpoint: string) => MockPnnRpc) {
  return (endpoint: string) => factory(endpoint);
}

function pnnPaymentUtxo(exact: ReturnType<typeof exactTransactionFixture>) {
  return {
    outpoint: { transactionId: exact.txid, index: 0 },
    utxoEntry: {
      amount: "120000000",
      scriptPublicKey: exact.payToScriptPublicKey,
    },
  };
}

function exactTransactionFixture() {
  const headRedeemScript = buildKip10AdditiveRedeemScript({
    ownerPublicKey: "55".repeat(32),
    amount: "10000000",
  });
  const headScriptPublicKey = serializedScriptPublicKey(
    payToScriptHashScript(headRedeemScript),
  ).toLowerCase();
  const payTo = addressForScriptPublicKey(
    headScriptPublicKey,
    "kaspa:testnet-10",
  );
  const payToScriptPublicKey = headScriptPublicKey;
  const txid = "11".repeat(32);
  const headTxid = "22".repeat(32);
  const fundingTxid = "33".repeat(32);
  const artifact = JSON.stringify({
    id: txid,
    version: 1,
    inputs: [
      {
        transactionId: headTxid,
        index: 0,
        sequence: "0",
        sigOpCount: 0,
        computeBudget: 10,
        signatureScript:
          buildKip10AdditiveBorrowSignatureScript(headRedeemScript),
        utxo: {
          amount: "100000000",
          scriptPublicKey: headScriptPublicKey,
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
        value: "120000000",
        scriptPublicKey: headScriptPublicKey,
      },
      {
        value: "19800000",
        scriptPublicKey:
          "000020bee817fbf708b7ad2b12530bcc99e285805ab64faeea22f6d31e2bbcb164edf9ac",
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
    headTxid,
    headScriptPublicKey,
    headRedeemScript,
    payTo,
    payToScriptPublicKey,
    artifact,
    restTransaction: {
      transaction_id: txid,
      version: 1,
      is_accepted: true,
      inputs: [
        {
          previous_outpoint_hash: headTxid,
          previous_outpoint_index: "0",
          signature_script:
            buildKip10AdditiveBorrowSignatureScript(headRedeemScript),
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
          amount: "120000000",
          script_public_key: headScriptPublicKey.slice(4),
        },
        {
          index: 1,
          amount: "19800000",
          script_public_key:
            "20bee817fbf708b7ad2b12530bcc99e285805ab64faeea22f6d31e2bbcb164edf9ac",
        },
      ],
    },
  };
}

function exactHeadFixture(
  exact: ReturnType<typeof exactTransactionFixture>,
): ExactHeadRecord {
  return {
    headId: "90".repeat(32),
    network: "kaspa:testnet-10",
    payTo: exact.payTo,
    templateId: "kaspa-x402-kip10-additive-v1",
    transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
    currentOutpoint: { txid: exact.headTxid, index: 0 },
    currentAmount: "100000000",
    scriptPublicKey: exact.headScriptPublicKey,
    redeemScript: exact.headRedeemScript,
    additiveThresholdSompi: "10000000",
    version: "0",
    status: "available",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  };
}

type AdditiveSafeArtifact = {
  id: string;
  version: 1;
  inputs: Array<{
    previousOutpoint: { transactionId: string; index: number };
    signatureScript: string;
    sequence: string;
    sigOpCount: number;
    computeBudget: number;
    utxo: { amount: string; scriptPublicKey: string };
  }>;
  outputs: Array<{ value: string; scriptPublicKey: string; covenant: null }>;
  lockTime: string;
  subnetworkId: string;
  gas: string;
  storageMass: string;
  payload: string;
};

function refreshAdditiveArtifact(artifact: AdditiveSafeArtifact): void {
  artifact.storageMass = calculateKaspaStorageMass({
    inputs: artifact.inputs.map((input) => ({
      amount: input.utxo.amount,
      scriptPublicKey: input.utxo.scriptPublicKey,
      hasCovenant: false,
    })),
    outputs: artifact.outputs.map((output) => ({
      amount: output.value,
      scriptPublicKey: output.scriptPublicKey,
      hasCovenant: false,
    })),
  }).toString();
  const reference: TxV1ReferenceTransaction = {
    version: 1,
    inputs: artifact.inputs.map((input) => ({
      previousOutpoint: {
        txid: input.previousOutpoint.transactionId,
        index: input.previousOutpoint.index,
      },
      signatureScript: input.signatureScript,
      sequence: input.sequence,
      computeBudget: input.computeBudget,
      utxo: {
        amount: input.utxo.amount,
        scriptPublicKey: input.utxo.scriptPublicKey,
        blockDaaScore: "0",
        isCoinbase: false,
        covenantId: null,
      },
    })),
    outputs: artifact.outputs.map((output) => ({
      amount: output.value,
      scriptPublicKey: output.scriptPublicKey,
      covenant: output.covenant,
    })),
    lockTime: artifact.lockTime,
    subnetworkId: artifact.subnetworkId,
    gas: artifact.gas,
    payload: artifact.payload,
    mass: artifact.storageMass,
    estimatedSerializedSize: 0,
  };
  artifact.id = transactionV1Id(reference);
}

function offlineExactVerifier(): RestExactTransactionVerifier {
  return new RestExactTransactionVerifier(
    new KaspaRestClient("https://api.example.test", {
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: "Transaction not found" }), {
            status: 404,
          }),
      ) as typeof fetch,
    }),
  );
}

function exactAuthorizationFields(input: {
  profile: "standard-native" | "additive";
  transactionId: string;
  paymentOutputIndex: number;
  amount: string;
  payTo: string;
  payToScriptPublicKey: string;
  challengeId?: string;
  inputIndex: number;
}) {
  const requestHash = "92".repeat(32);
  const paymentRequirementsHash = "93".repeat(32);
  const expiresAt = "2099-01-01T00:00:00.000Z";
  const digest = exactRequestAuthorizationDigest({
    network: "kaspa:testnet-10",
    profile: input.profile,
    transactionId: input.transactionId,
    paymentOutputIndex: input.paymentOutputIndex,
    amount: input.amount,
    payTo: input.payTo,
    payToScriptPublicKey: input.payToScriptPublicKey,
    paymentRequirementsHash,
    requestHash,
    challengeId: input.challengeId,
    inputIndex: input.inputIndex,
    expiresAt,
  });
  return {
    requestHash,
    paymentRequirementsHash,
    authorization: {
      version: "kaspa-x402-exact-request-authorization-v1" as const,
      inputIndex: input.inputIndex,
      expiresAt,
      digest,
      signature: Buffer.from(
        schnorr.sign(Buffer.from(digest, "hex"), new Uint8Array(32).fill(7)),
      ).toString("hex"),
    },
  };
}

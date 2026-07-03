import { afterEach, describe, expect, it, vi } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { KaspaRestClient, NativeAddressCodec, NativeVoucherVerifier, RestKaspaChainProvider, ScriptAddressBook } from "../src/adapters.js";
import { encodeScriptAddress, personalMessageHash, scriptPublicKeyForAddress } from "../src/kaspa-native.js";

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
  it("verifies Kaspa personal-message Schnorr signatures", () => {
    const secretKey = Uint8Array.from([
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03,
    ]);
    const publicKey = Buffer.from(schnorr.getPublicKey(secretKey)).toString("hex");
    const digest = "21".repeat(32);
    const signature = Buffer.from(schnorr.sign(personalMessageHash(digest), secretKey, new Uint8Array(32))).toString("hex");

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
});

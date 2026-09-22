import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";
import {
  decodePaymentRequiredHeader, encodePaymentSignatureHeader,
  paymentIdentifierExtension, sha256Hex, stableStringify,
} from "@kaspa-x402/core";
import { signHashChainExactTransaction } from "@kaspa-x402/client";
import { generateHashChainBorrowGrants, hashChainHeadScriptPublicKey } from "@kaspa-x402/covenant";
import { DirectModeServer, HashChainExactTransactionVerifier, MemoryServerChannelStore,
  type DirectModeServerConfig, type HashChainSelectedTransaction } from "../src/index.js";
import { HashChainGrantIssuer, hashChainGrantClaimDigest } from "../src/hash-chain-grants.js";

const OWNER = "56b328b30c8bf5839e24058747879408bdb36241dc9c2e7c619faa12b2920967";
const PAYER = Buffer.alloc(32, 7);
const PAYER_PUBLIC = Buffer.from(schnorr.getPublicKey(PAYER)).toString("hex");
const PAYER_SCRIPT = `000020${PAYER_PUBLIC}ac`;
const THIEF = Buffer.alloc(32, 8);
const THIEF_SCRIPT = `000020${Buffer.from(schnorr.getPublicKey(THIEF)).toString("hex")}ac`;
const RESOURCE = { url: "https://api.example.test/hash-chain/product" };
const HEAD_ID = "aa".repeat(32);
const COVENANT_ID = "de".repeat(32);
const HEAD_TX = "11".repeat(32);
const FUNDING_TX = "51".repeat(32);
const THIEF_FUNDING_TX = "52".repeat(32);

class FailOnceAfterAcceptanceStore extends MemoryServerChannelStore {
  failAfterAccept = false;
  override async acceptExactSettlement(...args: Parameters<MemoryServerChannelStore["acceptExactSettlement"]>): Promise<void> {
    await super.acceptExactSettlement(...args);
    if (this.failAfterAccept) {
      this.failAfterAccept = false;
      throw new Error("simulated crash after durable acceptance");
    }
  }
}

describe("native-KAS hash-chain x402 product path", () => {
  it("claims one grant, verifies the exact payer-signed successor, and only then runs protected work", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "kaspa-hash-chain-product-"));
    const issuer = await HashChainGrantIssuer.open({
      databasePath: path.join(folder, "grants.sqlite"), encryptionKey: randomBytes(32), canClaim: () => true,
    });
    try {
      const chain = generateHashChainBorrowGrants(2);
      const headScript = hashChainHeadScriptPublicKey({ ownerPublicKey: OWNER, guard: chain.initialGuard });
      issuer.installHead({
        headId: HEAD_ID, network: "kaspa:testnet-10", ownerPublicKey: OWNER,
        head: { outpoint: { txid: HEAD_TX, index: 0 }, amount: "100000000",
          guard: chain.initialGuard, scriptPublicKey: headScript, covenantId: COVENANT_ID },
        grants: chain.grants,
      });
      let selected: HashChainSelectedTransaction | null = null;
      const view = {
        async getAcceptedOrigin(outpoint: { txid: string; index: number }) {
          if (outpoint.txid === HEAD_TX) return { amount: "100000000", scriptPublicKey: headScript, covenantId: COVENANT_ID };
          if (outpoint.txid === FUNDING_TX) return { amount: "50000000", scriptPublicKey: PAYER_SCRIPT, covenantId: null };
          if (outpoint.txid === THIEF_FUNDING_TX) return { amount: "50000000", scriptPublicKey: THIEF_SCRIPT, covenantId: null };
          return null;
        },
        async getSelectedTransaction(txid: string) { return selected?.transactionId === txid ? selected : null; },
      };
      const addressCodec = {
        scriptPublicKeyForAddress(address: string) { return address.startsWith("kaspatest:hash-") ? nextScript : PAYER_SCRIPT; },
        encodeScriptAddress(input: { serializedScriptPublicKey: string }) {
          return `kaspatest:hash-${sha256Hex(input.serializedScriptPublicKey).slice(0, 32)}`;
        },
      };
      const nextScript = hashChainHeadScriptPublicKey({ ownerPublicKey: OWNER, guard: chain.grants[0]!.revealedGuard });
      let serverBroadcasts = 0;
      let failHeadRead = false;
      let headUnspent = true;
      const store = new FailOnceAfterAcceptanceStore();
      const config = {
        network: "kaspa:testnet-10", payTo: "kaspatest:merchant", serverPublicKey: OWNER,
        minDepositSompi: "1000", claimReserveSompi: "10", amount: "20000000",
        refundTimeoutDaa: "1000", minimumRefundLeadDaa: "0", confirmationThreshold: 30,
        store,
        chainProvider: { async getVirtualDaaScore() { return "0"; }, async sendTransaction() { serverBroadcasts++; throw new Error("server must not broadcast"); } } as unknown as DirectModeServerConfig["chainProvider"],
        addressCodec, voucherVerifier: { verifyVoucher: () => true },
        batchPresentationVerifier: { verifyPresentation: () => true },
        exactProfile: "hash-chain-additive",
        exactTransactionVerifier: new HashChainExactTransactionVerifier(view),
        hashChainIssuer: issuer, hashChainHeadId: HEAD_ID,
        hashChainGrantClaimUrl: "https://api.example.test/hash-chain/grant",
        hashChainIsSelected: async (txid) => (await view.getSelectedTransaction(txid)) !== null,
        hashChainCurrentHeadIsUnspent: async (head) => {
          if (failHeadRead) throw new Error("selected UTXO observer is unavailable");
          return headUnspent && head.outpoint.txid === (selected?.transactionId ?? HEAD_TX);
        },
      } as DirectModeServerConfig;
      expect(() => new DirectModeServer({ ...config, acceptedFinality: "confirmed" })).toThrow("accepted finality only");
      const server = new DirectModeServer(config);
      let protectedCalls = 0;
      const route = { url: RESOURCE.url, resource: RESOURCE, paymentScheme: "exact" as const };
      const unpaid = await server.handlePaidRequest(route, async () => { protectedCalls++; return { body: "paid" }; });
      expect(unpaid.status).toBe(402);
      const required = decodePaymentRequiredHeader(unpaid.headers["PAYMENT-REQUIRED"]!);
      const accepted = required.accepts[0]!;
      if (accepted.scheme !== "exact") throw new Error("expected exact offer");
      const extra = accepted.extra;
      const requestHash = sha256Hex(stableStringify({ method: "GET", url: RESOURCE.url, body: null }));
      const unsignedClaim = {
        grantId: extra.grantId!, challengeId: extra.challengeId!, requestHash,
        payerPublicKey: PAYER_PUBLIC, expiresAt: extra.challengeExpiresAt!,
      };
      const claim = { ...unsignedClaim, signature: Buffer.from(schnorr.sign(
        hashChainGrantClaimDigest("kaspa:testnet-10", unsignedClaim), PAYER,
      )).toString("hex") };
      headUnspent = false;
      await expect(server.claimHashChainGrant(claim)).rejects.toThrow("absent from the selected UTXO set");
      expect(issuer.getCurrent(HEAD_ID).phase).toBe("hold");
      headUnspent = true;
      issuer.reconcileObservedHead(HEAD_ID, issuer.getCurrent(HEAD_ID).head);
      failHeadRead = true;
      await expect(server.claimHashChainGrant(claim)).rejects.toThrow();
      expect(issuer.getCurrent(HEAD_ID).phase).toBe("ready");
      failHeadRead = false;
      const grant = await server.claimHashChainGrant(claim);
      const signingRequest = {
          attemptId: "a1".repeat(32), intentHash: "a2".repeat(32),
          network: "kaspa:testnet-10", profile: "hash-chain-additive",
          origin: "https://api.example.test", resourceUrl: RESOURCE.url,
          amount: accepted.amount, payTo: accepted.payTo,
          payToScriptPublicKey: extra.payToScriptPublicKey,
          paymentOutputIndex: 0, requestHash,
          paymentRequirementsHash: sha256Hex(stableStringify(accepted)),
          authorizationExpiresAt: extra.challengeExpiresAt!,
          hashChainHead: {
            headId: extra.headId!, headVersion: extra.headVersion!, covenantId: extra.covenantId!,
            expectedHeadOutpoint: extra.expectedHeadOutpoint!, headAmount: extra.headAmount!,
            headScriptPublicKey: extra.headScriptPublicKey!, headRedeemScript: extra.headRedeemScript!,
            currentGuard: extra.currentGuard!, nextGuard: extra.nextGuard!,
            oneTimePublicKey: extra.oneTimePublicKey!, grantId: extra.grantId!,
            grantClaimUrl: extra.grantClaimUrl!, challengeId: extra.challengeId!,
            challengeExpiresAt: extra.challengeExpiresAt!,
          }, grant,
        } as const;
      const signed = signHashChainExactTransaction({
        request: signingRequest,
        funding: { outpoint: { txid: FUNDING_TX, index: 0 }, amount: "50000000",
          scriptPublicKey: PAYER_SCRIPT, privateKey: PAYER.toString("hex"), payerAddress: "kaspatest:payer" },
        feeSompi: "300000",
      });
      const artifact = JSON.parse(signed.transaction);
      const payment = {
        x402Version: 2, accepted,
        payload: { type: "exact-transaction", profile: "hash-chain-additive",
          transaction: signed.transaction, transactionEncoding: signed.transactionEncoding,
          paymentOutputIndex: 0, authorization: signed.authorization,
          grantId: extra.grantId, challengeId: extra.challengeId, requestHash,
          payerAddress: "kaspatest:payer" },
        extensions: { "payment-identifier": paymentIdentifierExtension({ required: true, id: "hash_chain_product_0001" }) },
      };
      const stolen = signHashChainExactTransaction({ request: signingRequest,
        funding: { outpoint: { txid: THIEF_FUNDING_TX, index: 0 }, amount: "50000000",
          scriptPublicKey: THIEF_SCRIPT, privateKey: THIEF.toString("hex"), payerAddress: "kaspatest:thief" },
        feeSompi: "300000",
      });
      selected = { transactionId: stolen.transactionId, finality: "accepted",
        spentHead: { txid: HEAD_TX, index: 0 },
        successor: { amount: artifact.outputs[0].value, scriptPublicKey: nextScript,
          covenantId: COVENANT_ID, authorizingInput: 0 } };
      await expect(server.verifyPayment({ paymentPayload: { ...payment,
        payload: { ...payment.payload, transaction: stolen.transaction,
          authorization: stolen.authorization, payerAddress: "kaspatest:thief" } } as never,
        paymentRequirements: accepted, resource: RESOURCE, requestHash })).rejects.toThrow("assigned grant payer");
      selected = null;
      const paidRoute = { ...route, headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payment as never) } };
      const pending = await server.handlePaidRequest(paidRoute, async () => { protectedCalls++; return { body: "paid" }; });
      expect(pending.status).toBeGreaterThanOrEqual(400);
      expect(protectedCalls).toBe(0);
      selected = { transactionId: signed.transactionId, finality: "accepted",
        spentHead: { txid: HEAD_TX, index: 0 },
        successor: { amount: artifact.outputs[0].value, scriptPublicKey: nextScript,
          covenantId: COVENANT_ID, authorizingInput: 0 } };
      await server.verifyPayment({ paymentPayload: payment as never, paymentRequirements: accepted,
        resource: RESOURCE, requestHash });
      store.failAfterAccept = true;
      const interrupted = await server.handlePaidRequest(paidRoute, async () => { protectedCalls++; return { body: "paid" }; });
      expect(interrupted.status).not.toBe(200);
      expect((await store.loadExactSettlementAttempt(signed.transactionId))?.status).toBe("accepted");
      expect(protectedCalls).toBe(0);
      const selectedPayment = selected;
      selected = null;
      const staleAttempt = await server.handlePaidRequest(paidRoute, async () => { protectedCalls++; return { body: "paid" }; });
      expect(staleAttempt.status).toBe(503);
      expect(protectedCalls).toBe(0);
      expect(issuer.getCurrent(HEAD_ID).phase).toBe("hold");
      selected = selectedPayment;
      issuer.reconcileObservedHead(HEAD_ID, issuer.getCurrent(HEAD_ID).head);
      const paid = await server.handlePaidRequest(paidRoute, async () => { protectedCalls++; return { body: "paid" }; });
      expect(paid.status).toBe(200);
      expect(protectedCalls).toBe(1);
      expect(serverBroadcasts).toBe(0);
      expect(issuer.getCurrent(HEAD_ID)).toMatchObject({ headVersion: 1,
        head: { outpoint: { txid: signed.transactionId, index: 0 }, amount: "120000000" } });
      expect(issuer.getAcceptedPayment(signed.transactionId)?.grantId).toBe(extra.grantId);
      headUnspent = false;
      const staleOffer = await server.handlePaidRequest(route, async () => { protectedCalls++; return { body: "paid" }; });
      expect(staleOffer.status).toBe(503);
      expect(issuer.getCurrent(HEAD_ID).phase).toBe("hold");
      selected = null;
      const reorged = await server.handlePaidRequest(paidRoute, async () => { protectedCalls++; return { body: "paid" }; });
      expect(reorged.status).toBe(503);
      expect(protectedCalls).toBe(1);
      expect(issuer.getCurrent(HEAD_ID).phase).toBe("hold");
    } finally {
      issuer.close(); rmSync(folder, { recursive: true, force: true });
    }
  });
});

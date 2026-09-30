import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it, vi } from "vitest";
import {
  bindRequestHashToTrustedContext, decodePaymentRequiredHeader, encodePaymentSignatureHeader,
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
    let expiryClock: { mockRestore(): void } | undefined;
    const folder = mkdtempSync(path.join(tmpdir(), "kaspa-hash-chain-product-"));
    let claimEligible = true;
    const issuer = await HashChainGrantIssuer.open({
      databasePath: path.join(folder, "grants.sqlite"), encryptionKey: randomBytes(32),
      canClaim: () => claimEligible,
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
      let originBatches = 0;
      const view = {
        async getAcceptedOrigins(outpoints: readonly { txid: string; index: number }[]) {
          originBatches++;
          return outpoints.map((outpoint) => {
            if (outpoint.txid === HEAD_TX) return { amount: "100000000", scriptPublicKey: headScript, covenantId: COVENANT_ID };
            if (outpoint.txid === FUNDING_TX) return { amount: "50000000", scriptPublicKey: PAYER_SCRIPT, covenantId: null };
            if (outpoint.txid === THIEF_FUNDING_TX) return { amount: "50000000", scriptPublicKey: THIEF_SCRIPT, covenantId: null };
            return null;
          });
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
      let headReads = 0;
      let challengeEligible = true;
      let admissionCalls = 0;
      let verifierCalls = 0;
      const referenceVerifier = new HashChainExactTransactionVerifier(view);
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
        exactTransactionVerifier: {
          verifyExactPayment(request) {
            verifierCalls++;
            return referenceVerifier.verifyExactPayment(request);
          },
        },
        hashChainIssuer: issuer, hashChainHeadId: HEAD_ID,
        hashChainGrantClaimUrl: "https://api.example.test/hash-chain/grant",
        admitHashChainChallenge: async () => {
          admissionCalls++;
          return challengeEligible;
        },
        hashChainIsSelected: async (txid) => (await view.getSelectedTransaction(txid)) !== null,
        hashChainGetCurrentUtxo: async (outpoint) => {
          headReads++;
          if (failHeadRead) throw new Error("selected UTXO observer is unavailable");
          const current = issuer.getCurrent(HEAD_ID).head;
          if (!headUnspent || outpoint.txid !== (selected?.transactionId ?? current.outpoint.txid)) {
            return null;
          }
          return {
            outpoint: current.outpoint,
            amount: current.amount,
            scriptPublicKey: current.scriptPublicKey,
            covenantId: current.covenantId,
          };
        },
      } as DirectModeServerConfig;
      expect(() => new DirectModeServer({ ...config, acceptedFinality: "confirmed" })).toThrow("accepted finality only");
      const server = new DirectModeServer(config);
      let protectedCalls = 0;
      const trustedSecurityContext = { principal: "hash-chain-product-test", tenant: "merchant-test" };
      const anonymousRoute = { url: RESOURCE.url, resource: RESOURCE, paymentScheme: "exact" as const };
      const fallback = await server.handlePaidRequest({
        url: RESOURCE.url,
        resource: RESOURCE,
        paymentSchemes: ["exact", "batch-settlement"],
      }, async () => ({ body: "must not run" }));
      expect(fallback.status).toBe(402);
      const fallbackRequired = decodePaymentRequiredHeader(fallback.headers["PAYMENT-REQUIRED"]!);
      expect(fallbackRequired.accepts.length).toBeGreaterThan(0);
      expect(fallbackRequired.accepts.every((item) => item.scheme === "batch-settlement")).toBe(true);
      for (let index = 0; index < 65; index++) {
        const rejected = await server.handlePaidRequest(
          { ...anonymousRoute, url: `${RESOURCE.url}?anonymous=${index}`,
            resource: { url: `${RESOURCE.url}?anonymous=${index}` } },
          async () => ({ body: "must not run" }),
        );
        expect(rejected.status).toBe(503);
      }
      expect(headReads).toBe(0);
      challengeEligible = false;
      for (let index = 0; index < 65; index++) {
        const deniedUrl = `${RESOURCE.url}?denied=${index}`;
        const denied = await server.handlePaidRequest({
          ...anonymousRoute,
          url: deniedUrl,
          resource: { url: deniedUrl },
          trustedSecurityContext: {
            principal: `ineligible-${index}`,
            tenant: "merchant-test",
          },
        }, async () => ({ body: "must not run" }));
        expect(denied.status).toBe(503);
      }
      expect(headReads).toBe(0);
      expect(admissionCalls).toBe(65);
      challengeEligible = true;
      const route = { ...anonymousRoute, trustedSecurityContext };
      const unpaid = await server.handlePaidRequest(route, async () => { protectedCalls++; return { body: "paid" }; });
      expect(unpaid.status).toBe(402);
      expect(headReads).toBe(1);
      expect(admissionCalls).toBe(66);
      const required = decodePaymentRequiredHeader(unpaid.headers["PAYMENT-REQUIRED"]!);
      const accepted = required.accepts[0]!;
      if (accepted.scheme !== "exact") throw new Error("expected exact offer");
      const repeatedUnpaid = await server.handlePaidRequest(
        route,
        async () => ({ body: "must not run" }),
      );
      const repeatedRequired = decodePaymentRequiredHeader(
        repeatedUnpaid.headers["PAYMENT-REQUIRED"]!,
      );
      expect(repeatedRequired.accepts[0]?.extra.challengeId)
        .toBe(accepted.extra.challengeId);
      expect(admissionCalls).toBe(66);
      const concurrentUrl = `${RESOURCE.url}?concurrent-retry=1`;
      const concurrentRoute = {
        ...route,
        url: concurrentUrl,
        resource: { url: concurrentUrl },
      };
      const callsBeforeConcurrentRetry = admissionCalls;
      const [concurrentFirst, concurrentSecond] = await Promise.all([
        server.handlePaidRequest(
          concurrentRoute,
          async () => ({ body: "must not run" }),
        ),
        server.handlePaidRequest(
          concurrentRoute,
          async () => ({ body: "must not run" }),
        ),
      ]);
      const concurrentFirstRequired = decodePaymentRequiredHeader(
        concurrentFirst.headers["PAYMENT-REQUIRED"]!,
      );
      const concurrentSecondRequired = decodePaymentRequiredHeader(
        concurrentSecond.headers["PAYMENT-REQUIRED"]!,
      );
      expect(concurrentSecondRequired.accepts[0]?.extra.challengeId)
        .toBe(concurrentFirstRequired.accepts[0]?.extra.challengeId);
      expect(admissionCalls).toBe(callsBeforeConcurrentRetry + 1);
      const extra = accepted.extra;
      const requestHash = bindRequestHashToTrustedContext(
        sha256Hex(stableStringify({ method: "GET", url: RESOURCE.url, body: null })),
        trustedSecurityContext,
      );
      const unsignedClaim = {
        grantId: extra.grantId!, challengeId: extra.challengeId!, requestHash,
        payerPublicKey: PAYER_PUBLIC, expiresAt: new Date(Date.now() + 10_000).toISOString(),
      };
      const claim = { ...unsignedClaim, signature: Buffer.from(schnorr.sign(
        hashChainGrantClaimDigest("kaspa:testnet-10", unsignedClaim), PAYER,
      )).toString("hex") };
      const readsBeforeInvalidClaims = headReads;
      await expect(server.claimHashChainGrant({} as never, trustedSecurityContext)).rejects.toThrow();
      await expect(server.claimHashChainGrant({ ...claim, signature: "00".repeat(64) }, trustedSecurityContext))
        .rejects.toThrow("invalid grant payer signature");
      claimEligible = false;
      await expect(server.claimHashChainGrant(claim, trustedSecurityContext)).rejects.toThrow("payer is ineligible");
      claimEligible = true;
      expect(headReads).toBe(readsBeforeInvalidClaims);
      await expect(server.claimHashChainGrant(claim, {
        principal: "another-hash-chain-caller",
        tenant: "merchant-test",
      })).rejects.toThrow("grant claim admission changed");
      expect(headReads).toBe(readsBeforeInvalidClaims);
      expect(issuer.getCurrent(HEAD_ID).phase).toBe("ready");
      headUnspent = false;
      await expect(server.claimHashChainGrant(claim, trustedSecurityContext)).rejects.toThrow("authoritative selected UTXO");
      expect(issuer.getCurrent(HEAD_ID).phase).toBe("hold");
      headUnspent = true;
      expect(issuer.reconcileObservedHead(HEAD_ID, issuer.getCurrent(HEAD_ID).head).phase).toBe("ready");
      failHeadRead = true;
      await expect(server.claimHashChainGrant(claim, trustedSecurityContext)).rejects.toThrow();
      expect(issuer.getCurrent(HEAD_ID).phase).toBe("ready");
      expect(issuer.getDeliveryRecord(HEAD_ID, extra.grantId!)).toBeUndefined();
      failHeadRead = false;
      const grant = await server.claimHashChainGrant(claim, trustedSecurityContext);
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
      const readsBeforeStolenProof = originBatches;
      const callsBeforeStolenProof = verifierCalls;
      await expect(server.verifyPayment({ paymentPayload: { ...payment,
        payload: { ...payment.payload, transaction: stolen.transaction,
          authorization: stolen.authorization, payerAddress: "kaspatest:thief" } } as never,
        paymentRequirements: accepted, resource: RESOURCE, requestHash })).rejects.toThrow("assigned grant");
      expect(originBatches).toBe(readsBeforeStolenProof);
      expect(verifierCalls).toBe(callsBeforeStolenProof);
      selected = null;
      const paidRoute = { ...route, headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payment as never) } };
      const pending = await server.handlePaidRequest(paidRoute, async () => { protectedCalls++; return { body: "paid" }; });
      expect(pending.status).toBeGreaterThanOrEqual(400);
      expect(protectedCalls).toBe(0);
      const competing = signHashChainExactTransaction({
        request: signingRequest,
        funding: {
          outpoint: { txid: THIEF_FUNDING_TX, index: 0 },
          amount: "50000000",
          scriptPublicKey: PAYER_SCRIPT,
          privateKey: PAYER.toString("hex"),
          payerAddress: "kaspatest:payer",
        },
        feeSompi: "300000",
      });
      const callsBeforeCompetingProof = verifierCalls;
      const readsBeforeCompetingProof = originBatches;
      await expect(server.verifyPayment({
        paymentPayload: {
          ...payment,
          payload: {
            ...payment.payload,
            transaction: competing.transaction,
            authorization: competing.authorization,
          },
        } as never,
        paymentRequirements: accepted,
        resource: RESOURCE,
        requestHash,
      })).rejects.toThrow("another payment candidate");
      expect(verifierCalls).toBe(callsBeforeCompetingProof);
      expect(originBatches).toBe(readsBeforeCompetingProof);
      selected = { transactionId: signed.transactionId, finality: "accepted",
        spentHead: { txid: HEAD_TX, index: 0 },
        successor: { amount: artifact.outputs[0].value, scriptPublicKey: nextScript,
          covenantId: COVENANT_ID, authorizingInput: 0 } };
      headUnspent = false;
      await expect(server.claimHashChainGrant(claim, trustedSecurityContext)).rejects.toThrow("authoritative selected UTXO");
      expect(issuer.getCurrent(HEAD_ID).phase).toBe("hold");
      await server.verifyPayment({ paymentPayload: payment as never, paymentRequirements: accepted,
        resource: RESOURCE, requestHash });
      store.failAfterAccept = true;
      const interrupted = await server.handlePaidRequest(paidRoute, async () => { protectedCalls++; return { body: "paid" }; });
      expect(interrupted.status).not.toBe(200);
      expect((await store.loadExactSettlementAttempt(signed.transactionId))?.status).toBe("accepted");
      expect(protectedCalls).toBe(0);
      // An identical durably accepted payment can finish after the shorter
      // delivered grant expires, without constructing or broadcasting again.
      expiryClock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(grant.expiresAt) + 1);
      expect(Date.now()).toBeLessThan(Date.parse(extra.challengeExpiresAt!));
      const selectedPayment = selected;
      selected = null;
      const staleAttempt = await server.handlePaidRequest(paidRoute, async () => { protectedCalls++; return { body: "paid" }; });
      expect(staleAttempt.status).toBe(503);
      expect(protectedCalls).toBe(0);
      expect(issuer.getCurrent(HEAD_ID).phase).toBe("hold");
      selected = selectedPayment;
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
      expiryClock?.mockRestore();
      issuer.close(); rmSync(folder, { recursive: true, force: true });
    }
  });
});

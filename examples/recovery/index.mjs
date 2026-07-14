import { createMockDirectModeEnvironment, mockHash, X402_VERSION } from "../lib/mock-direct-mode.mjs";

const { client, facilitator, server, serverStore } = createMockDirectModeEnvironment();

const batch = await client.paidFetch("https://api.example.test/metered", {
  paymentIdentifier: "recovery_batch_1",
});
const exact = await client.paidFetch("https://api.example.test/download", {
  paymentIdentifier: "recovery_exact_1",
});

const [serverChannel] = await serverStore.listChannels();
const corrective = server.buildPaymentRequired({
  resource: { url: "https://api.example.test/metered" },
  amount: "50000",
  scheme: "batch-settlement",
  channel: serverChannel,
  voucherState: serverChannel.voucherSignature
    ? {
        amount: serverChannel.signedMaxClaimable,
        signature: serverChannel.voucherSignature,
      }
    : undefined,
});
const exactReplay = await facilitator.verify({
  x402Version: X402_VERSION,
  paymentPayload: exact.payment.paymentPayload,
  paymentRequirements: exact.payment.accepted,
  resource: { url: "https://api.example.test/download" },
  requestHash: mockHash("exact-replay-other-request"),
});
const refundable = await client.listRefundableChannels("1001");

console.log(
  JSON.stringify(
    {
      clientStateLost: {
        channelId: batch.payment.channel.id,
        recoveryMaterial: ["channelConfig", "activeOutpoint", "activeScriptPublicKey", "latestVoucher"],
      },
      serverStateLost: {
        channelId: serverChannel.channelId,
        recoveryMaterial: ["deposit-voucher payload", "latest voucher payload", "funding UTXO"],
      },
      exactReplay,
      corrective402: {
        hasChannelState: Boolean(corrective.accepts[0].extra.channelState),
        hasVoucherState: Boolean(corrective.accepts[0].extra.voucherState),
      },
      refundPreview: {
        refundableChannels: refundable.length,
        refundAmount: refundable[0]?.fundingAmount ?? null,
      },
    },
    null,
    2,
  ),
);

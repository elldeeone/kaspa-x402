import { createMockDirectModeEnvironment } from "../lib/mock-direct-mode.mjs";

const { client } = createMockDirectModeEnvironment({
  requirePaymentIdentifier: true,
});

const exact = await client.paidFetch("https://api.example.test/download", {
  paymentIdentifier: "http_exact_download_1",
});
const firstBatch = await client.paidFetch("https://api.example.test/metered", {
  paymentIdentifier: "http_batch_metered_1",
});
const secondBatch = await client.paidFetch("https://api.example.test/metered", {
  paymentIdentifier: "http_batch_metered_2",
});

console.log(
  JSON.stringify(
    {
      exact: {
        status: exact.response.status,
        scheme: exact.payment?.scheme,
        settlement: exact.settlement?.response.success,
      },
      batch: {
        firstOpenedChannel: firstBatch.payment?.openedChannel,
        secondOpenedChannel: secondBatch.payment?.openedChannel,
        firstChargedAmount: firstBatch.settlement?.chargedAmount,
        secondChargedAmount: secondBatch.settlement?.chargedAmount,
      },
    },
    null,
    2,
  ),
);

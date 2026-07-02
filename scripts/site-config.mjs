export const SITE_BASE_URL = "https://kaspa-x402.org";
export const SITE_DIST = "site/dist";
export const SITE_SRC = "site/src";
export const RELEASE_LOCK_DIR = "site/releases";

export const SITE_ASSET_FILES = [];

export const SCHEMA_FILES = [
  "schemas/payment-required.schema.json",
  "schemas/payment-payload.schema.json",
  "schemas/settlement-response.schema.json",
  "schemas/kaspa-requirements-extra.schema.json",
  "schemas/kaspa-payment-payload.schema.json",
  "schemas/kaspa-batch-extra.schema.json",
  "schemas/payment-identifier.schema.json",
  "schemas/channel-state.schema.json",
];

export const SPEC_FILES = [
  "spec/kaspa-x402-v1.md",
  "spec/kaspa-exact-v1.md",
  "spec/kaspa-batch-settlement-v1.md",
  "spec/http-profile.md",
  "spec/mcp-profile.md",
  "spec/facilitator-profile.md",
  "spec/errors.md",
  "spec/live-covenant-proof-harness.md",
  "spec/transaction-v1-plan.md",
];

export const PUBLIC_DOC_FILES = [
  "docs/public-proposal.md",
  "docs/adoption-examples.md",
  "docs/live-testnet-report.md",
  "docs/live-testnet-proof.md",
  "docs/review-closure-ledger.md",
  "docs/security-threat-model.md",
  "docs/mainnet-readiness.md",
  "docs/versioning-policy.md",
  "docs/native-profile-boundary.md",
  "docs/server-store-contract.md",
  "docs/server-runtime-lock-contract.md",
];

// One-line purpose for each published artifact, shown next to it in index pages.
export const ARTIFACT_NOTES = {
  "schemas/payment-required.schema.json":
    "x402 v2 `PaymentRequired` envelope: the 402 offer body listing accepted payment requirements.",
  "schemas/payment-payload.schema.json":
    "x402 v2 `PaymentPayload` envelope carried on the paid retry.",
  "schemas/settlement-response.schema.json":
    "x402 v2 `SettlementResponse` returned after verification and settlement.",
  "schemas/kaspa-requirements-extra.schema.json":
    "Kaspa-specific `extra` object inside offered payment requirements.",
  "schemas/kaspa-payment-payload.schema.json":
    "Kaspa payload body: exact transfer, escrow deposit, and voucher shapes.",
  "schemas/kaspa-batch-extra.schema.json":
    "Escrow parameters for `batch-settlement` offers (`kaspa-escrow-v1`).",
  "schemas/payment-identifier.schema.json":
    "Payment identifier binding a payment to transaction id and outpoint material.",
  "schemas/channel-state.schema.json":
    "Escrow channel state document used by batch-settlement stores.",
  "spec/kaspa-x402-v1.md":
    "Core binding: common rules for x402 v2 payments on Kaspa — networks, asset, amounts, envelopes.",
  "spec/kaspa-exact-v1.md":
    "`exact` profile: fixed-price one-shot native KAS transfer.",
  "spec/kaspa-batch-settlement-v1.md":
    "`batch-settlement` profile: escrow funding, cumulative vouchers, claim and refund.",
  "spec/http-profile.md":
    "HTTP transport: `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and `PAYMENT-RESPONSE` flow.",
  "spec/mcp-profile.md":
    "MCP transport: paid tools using the standard `_meta` payment fields.",
  "spec/facilitator-profile.md":
    "Optional self-hosted facilitator: `/supported`, `/verify`, `/settle` compatibility surface.",
  "spec/errors.md":
    "Error reasons: public x402 error codes and mapping rules for Kaspa-local diagnostics.",
  "spec/live-covenant-proof-harness.md":
    "Opt-in live proof runner that exercises covenant flows on `kaspa:testnet-10`.",
  "spec/transaction-v1-plan.md":
    "Transaction-builder requirements and vector coverage for claim/refund artifacts.",
  "docs/public-proposal.md":
    "Ecosystem-facing proposal: what is proposed to the x402 and Kaspa communities, and why.",
  "docs/adoption-examples.md":
    "How existing x402 servers, clients, and facilitators would adopt the Kaspa profiles.",
  "docs/live-testnet-report.md":
    "Live `kaspa:testnet-10` run: executed flows, transaction ids, and observed behavior.",
  "docs/live-testnet-proof.md":
    "How live proof artifacts are produced and independently validated.",
  "docs/review-closure-ledger.md":
    "External review findings and how each one was resolved.",
  "docs/security-threat-model.md":
    "Threat model: trust boundaries, attacker capabilities, and mitigations.",
  "docs/mainnet-readiness.md":
    "The gates that block mainnet use and what closing each one requires.",
  "docs/versioning-policy.md":
    "Compatibility and versioning rules for schemas, specs, vectors, and packages.",
  "docs/native-profile-boundary.md":
    "Why the native surface is limited to `exact` and `batch-settlement`.",
  "docs/server-store-contract.md":
    "Requirements for host-provided channel and settlement stores.",
  "docs/server-runtime-lock-contract.md":
    "Requirements for host-provided runtime locks guarding settlement concurrency.",
};

// Grouping for the /docs/ index page, in display order.
export const DOC_GROUPS = [
  { title: "Proposal", files: ["docs/public-proposal.md", "docs/adoption-examples.md"] },
  {
    title: "Evidence",
    files: ["docs/live-testnet-report.md", "docs/live-testnet-proof.md", "docs/review-closure-ledger.md"],
  },
  { title: "Safety", files: ["docs/security-threat-model.md", "docs/mainnet-readiness.md"] },
  { title: "Policy", files: ["docs/versioning-policy.md", "docs/native-profile-boundary.md"] },
  {
    title: "Contracts",
    files: ["docs/server-store-contract.md", "docs/server-runtime-lock-contract.md"],
  },
];

// Grouping for the /vectors/ index page, in display order.
export const VECTOR_GROUPS = [
  { dir: "x402-http", note: "End-to-end HTTP envelope fixtures." },
  { dir: "settlement-response", note: "Settlement responses for claim, refund, deposit, voucher, and failure cases." },
  { dir: "voucher", note: "Voucher digest and signature binding." },
  { dir: "channel-id", note: "Canonical channel id derivation." },
  { dir: "tx-v1", note: "Transaction-v1 claim and refund reference artifacts." },
  { dir: "negative", note: "Inputs that must fail validation." },
];

export const PRIVATE_SITE_PATTERNS = [
  /^docs\/goal\.md$/,
  /^docs\/standard-plan\.md$/,
  /^finding\.md$/,
  /^docs\/.*-review\.md$/,
  /^docs\/alpha-publish\.md$/,
  /^docs\/site-architecture\.md$/,
  /^\.kaspa-x402-live\//,
  /^\.kaspa-x402-consensus-target\//,
  /^node_modules\//,
  /^site\/dist\//,
  /^\.wrangler\//,
  /(?:^|\/)\.env(?:\.|$)/,
  /(?:^|\/)[^/]*\.pem$/,
  /(?:^|\/)[^/]*\.key$/,
];

export const PUBLISHABLE_PACKAGES = [
  "@kaspa-x402/core",
  "@kaspa-x402/covenant",
  "@kaspa-x402/client",
  "@kaspa-x402/server",
];

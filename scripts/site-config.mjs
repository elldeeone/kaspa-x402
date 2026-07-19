export const SITE_BASE_URL = "https://kaspa-x402.org";
export const SITE_DIST = "site/dist";
export const SITE_SRC = "site/src";
export const RELEASE_LOCK_DIR = "site/releases";
export const RELEASE_SNAPSHOT_DIR = "site/releases/snapshots";

export const VENDORED_KASPA_WASM = {
  package: "kaspa-wasm",
  version: "2.0.0",
  route: "/vendor/kaspa-wasm/2.0.0/kaspa-core/kaspa.js",
  source: {
    repository: "https://github.com/kaspanet/rusty-kaspa",
    release: "https://github.com/kaspanet/rusty-kaspa/releases/tag/v2.0.0",
    archive:
      "https://github.com/kaspanet/rusty-kaspa/releases/download/v2.0.0/kaspa-wasm32-sdk-v2.0.0.zip",
    archiveSha256:
      "eeb201e27feba98fe069f09ffefdd0032ed4f69a3f299793e64b9db9dda7df7f",
    commit: "90dbf074275d60c1fe74a3491883196f110970c0",
    packagePath: "web/kaspa-core",
    note: "Vendored from the Rusty Kaspa v2.0.0 web/kaspa-core browser release artifacts, not from the public npm registry.",
  },
  files: [
    {
      source: "site/src/vendor/kaspa-wasm/2.0.0/kaspa-core/LICENSE",
      target: "vendor/kaspa-wasm/2.0.0/kaspa-core/LICENSE",
      sha256:
        "fb06b99a835c4cdade7f2f180fd87c0198d552cf1e0cd14c34716411b009a92f",
    },
    {
      source: "site/src/vendor/kaspa-wasm/2.0.0/kaspa-core/kaspa.d.ts",
      target: "vendor/kaspa-wasm/2.0.0/kaspa-core/kaspa.d.ts",
      sha256:
        "081c3027542dadfff6793f78352faf13073cbd894defe0da49f97c2466f5754a",
    },
    {
      source: "site/src/vendor/kaspa-wasm/2.0.0/kaspa-core/kaspa.js",
      target: "vendor/kaspa-wasm/2.0.0/kaspa-core/kaspa.js",
      sha256:
        "84d0718fb99a9ea1fecbe5f95e82985e0cb1e7ea1c1214163b3f056ef6e9a6cb",
    },
    {
      source: "site/src/vendor/kaspa-wasm/2.0.0/kaspa-core/kaspa_bg.wasm",
      target: "vendor/kaspa-wasm/2.0.0/kaspa-core/kaspa_bg.wasm",
      sha256:
        "2fc3ed6c3666937a2598bf6a626e3ae97896e0ac8bc872ea049cb73df221191d",
    },
    {
      source: "site/src/vendor/kaspa-wasm/2.0.0/kaspa-core/package.json",
      target: "vendor/kaspa-wasm/2.0.0/kaspa-core/package.json",
      sha256:
        "848c1ad33dd4236fdf71513c6021ec3b08187d49abf0c3be18f40255917871dc",
    },
  ],
};

export const SITE_ASSET_FILES = [
  "site/src/assets/demo.css",
  "site/src/assets/demo.js",
  "site/src/assets/og.png",
  "site/src/vendor/kaspa-wasm/2.0.0/kaspa-core/LICENSE",
  "site/src/vendor/kaspa-wasm/2.0.0/kaspa-core/kaspa.d.ts",
  "site/src/vendor/kaspa-wasm/2.0.0/kaspa-core/kaspa.js",
  "site/src/vendor/kaspa-wasm/2.0.0/kaspa-core/kaspa_bg.wasm",
  "site/src/vendor/kaspa-wasm/2.0.0/kaspa-core/package.json",
];

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
  "spec/kaspa-exact-v2.md",
  "spec/kaspa-batch-settlement-v1.md",
  "spec/http-profile.md",
  "spec/mcp-profile.md",
  "spec/facilitator-profile.md",
  "spec/errors.md",
];

export const RELEASE_DOC_FILES = [
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

export const PUBLIC_DOC_FILES = [
  "docs/adoption-examples.md",
  "docs/testnet-gateway.md",
  "docs/demo-operations.md",
  "docs/demo-implementer-guide.md",
  ...RELEASE_DOC_FILES.slice(2),
];

// Compatibility aliases keep previously published unversioned URLs useful
// without presenting historical or internal evidence as current guidance.
export const ACTIVE_REDIRECTS = [
  {
    from: "/spec/kaspa-exact-v1/",
    to: "/v0.1.0-alpha.7/spec/kaspa-exact-v1.md",
    status: 302,
  },
  {
    from: "/spec/live-covenant-proof-harness/",
    to: "/docs/live-testnet-proof/",
    status: 302,
  },
  {
    from: "/spec/transaction-v1-plan/",
    to: "/spec/kaspa-batch-settlement-v1/",
    status: 302,
  },
  { from: "/docs/public-proposal/", to: "/", status: 302 },
  {
    from: "/docs/demo-interop-checklist/",
    to: "/docs/demo-implementer-guide/",
    status: 302,
  },
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
  "spec/kaspa-exact-v2.md":
    "Active `exact` binding: default standard-native transfer and optional KIP-10 additive head payment.",
  "spec/kaspa-exact-v1.md":
    "Superseded alpha.7 `exact` profile retained as the KIP-10 reservation record.",
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
  "docs/testnet-gateway.md":
    "Hosted `kaspa:testnet-10` gateway for exact and batch-settlement integration tests.",
  "docs/demo-operations.md":
    "Operator runbook for the hosted testnet gateway: deploy, rollback, disable, canary, state, and incident notes.",
  "docs/demo-implementer-guide.md":
    "Third-party implementer guide for schemas, vectors, exact and batch gateway calls, and error handling.",
  "docs/demo-interop-checklist.md":
    "External-style checklist for whether the public demo surface is usable without repository context.",
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
  { title: "Adoption", files: ["docs/adoption-examples.md"] },
  {
    title: "Implementation",
    files: [
      "docs/demo-implementer-guide.md",
      "docs/server-store-contract.md",
      "docs/server-runtime-lock-contract.md",
    ],
  },
  {
    title: "Testnet Deployment",
    files: ["docs/testnet-gateway.md", "docs/demo-operations.md"],
  },
  {
    title: "Evidence",
    files: [
      "docs/live-testnet-report.md",
      "docs/live-testnet-proof.md",
      "docs/review-closure-ledger.md",
    ],
  },
  {
    title: "Safety",
    files: ["docs/security-threat-model.md", "docs/mainnet-readiness.md"],
  },
  {
    title: "Policy",
    files: ["docs/versioning-policy.md", "docs/native-profile-boundary.md"],
  },
];

// Grouping for the /vectors/ index page, in display order.
export const VECTOR_GROUPS = [
  { dir: "x402-http", note: "End-to-end HTTP envelope fixtures." },
  {
    dir: "settlement-response",
    note: "Settlement responses for claim, refund, deposit, voucher, and failure cases.",
  },
  { dir: "voucher", note: "Voucher digest and signature binding." },
  { dir: "channel-id", note: "Canonical channel id derivation." },
  {
    dir: "tx-v1",
    note: "Transaction-v1 claim and refund reference artifacts.",
  },
  {
    dir: "exact",
    note: "Full-consensus standard-native and additive exact reference transactions.",
  },
  {
    dir: "batch",
    note: "Language-neutral channel, escrow, voucher, commitment, claim, refund, expiry, and finality evidence.",
  },
  { dir: "negative", note: "Inputs that must fail validation." },
];

export const PRIVATE_SITE_PATTERNS = [
  /^docs\/goal\.md$/,
  /^docs\/standard-plan\.md$/,
  /^finding\.md$/,
  /^docs\/.*-review\.md$/,
  /^docs\/alpha-publish\.md$/,
  /^docs\/site-architecture\.md$/,
  /^docs\/demo-announcement-draft\.md$/,
  /^docs\/x402-submission-draft\.md$/,
  /^docs\/caip-namespace-draft\.md$/,
  /^docs\/x402-v2-compat-report\.md$/,
  /^docs\/kaspa-community-post-draft\.md$/,
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

export const SITE_PACKAGE_NAMES = [
  "@kaspa-x402/cli",
  "@kaspa-x402/client",
  "@kaspa-x402/core",
  "@kaspa-x402/covenant",
  "@kaspa-x402/facilitator",
  "@kaspa-x402/server",
];

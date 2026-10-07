# RC2 Release

Template scope: the RC2 release and its funded/hosted evidence use escrow-v4
and hash-chain-head-v1. Development escrow-v5/head-v2 allow signer-chosen
sighash types, with ALL as the reference signing default, and require fresh
funded proof before a release claim. See the
[signature policy and template transition](versioning-policy.md#sighash-template-transition).

Status: **`1.0.0-rc.2` released on 2026-10-01 for Testnet-10**.

The [GitHub prerelease](https://github.com/elldeeone/kaspa-x402/releases/tag/v1.0.0-rc.2)
publishes the source, package archives, `rc2-evidence.json`, and `SHA256SUMS`.
The release source commit is `724c5fff22de500fcf729c43b59d25036fbffa9c`.
This website also receives documentation and rendering updates after release;
its build commit is reported in [release metadata](https://kaspa-x402.org/release.json).

## Packages

The four public packages are published as `1.0.0-rc.2` under the npm `rc` tag:

- `@kaspa-x402/core`
- `@kaspa-x402/covenant`
- `@kaspa-x402/client`
- `@kaspa-x402/server`

For example:

```sh
npm install @kaspa-x402/core@1.0.0-rc.2 @kaspa-x402/client@1.0.0-rc.2
```

`latest` remains on the earlier alpha channel. Use the exact RC2 version or
`@rc` for this release. The facilitator, CLI, and hosted gateway are available
as repository source rather than public npm packages.

## Payment Profiles

RC2 ships two x402 schemes: `exact` and `batch-settlement`.

- **Standard-native exact:** a fixed-price ordinary KAS transfer.
- **KIP-10 additive exact:** an optional merchant-head payment whose successor
  increases by the exact quoted amount.
- **Hash-chain additive exact:** an optional native-KAS profile using a privately
  assigned OTP-style one-time signing grant. The payer signs and broadcasts
  independently;
  the head advances its hash-chain guard after an accepted spend. See the
  [OTP-style authorization section](../spec/kaspa-hash-chain-exact-v1.md#otp-style-one-time-authorization).
- **Batch settlement:** a funded KIP-20 escrow channel supporting cumulative
  vouchers, partial claims, top-ups, refund, and durable recovery.

The published schemas, vectors, and TypeScript implementations include all of
these profiles. The protocol remains an interoperability proposal; publication
of RC2 does not establish upstream registry acceptance or mainnet readiness.

## Hosted Gateway And Browser Demo

The [Testnet-10 gateway](https://demo.kaspa-x402.org) serves RC2 standard-native,
batch, and hash-chain payments. KIP-10 additive offers require an operator to
configure and register an available head.

The gateway uses configured Testnet-10 **PNN/WSS nodes** for funding, UTXOs,
transaction acceptance, fees, and selected-chain lineage. Hosted payments no
longer depend on the public REST transaction index. Durable payment receipts
and checkpoints support retries and recovery after Worker restart.

Use the [browser demo](https://kaspa-x402.org/demo/) for hash-chain payments, or the
[implementer guide](../../docs/demo-implementer-guide.md) for gateway integration.
Availability and funded-head state can change; check
[/health](https://demo.kaspa-x402.org/health),
[/canary](https://demo.kaspa-x402.org/canary), and
[/hash-chain/status](https://demo.kaspa-x402.org/hash-chain/status).

## Release Validation

The release evidence records:

1. Passing `validate:release`, pinned consensus checks, and Linux/Windows CI.
2. All 18 fresh funded Testnet-10 exact, batch, recovery, and refund flows.
3. Hosted native payment and retry, with cross-resource replay rejected.
4. Hosted batch deposit, voucher, and duplicate retry.
5. Three browser hash-chain payments across owner rotation, including wallet
   and browser-storage cleanup.
6. Identical native, batch, and hash-chain retries recovering the same
   settlements after gateway redeployment.

Package checksums and registry integrity checks identify the published bytes.
These proofs use configured public Testnet-10 nodes, without independent-node
corroboration. An abandoned hash-chain grant can require operator head rotation.
The remaining [mainnet readiness gates](mainnet-readiness.md) still apply.

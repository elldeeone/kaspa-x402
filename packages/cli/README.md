# @kaspa-x402/cli

CLI tools for conformance vectors, channel inspection, claim preview, claim execution, and refund workflows.

Status: workspace-private alpha tooling. It is not published on npm and must not
be treated as a production broadcaster or custody tool.

## Build

```sh
npm --workspace @kaspa-x402/cli run build
```

## Commands

```sh
node packages/cli/dist/index.js --help
node packages/cli/dist/index.js vectors verify
node packages/cli/dist/index.js exact inspect --payment payment.json
node packages/cli/dist/index.js exact verify --payment payment.json --requirements payment-required.json
node packages/cli/dist/index.js channel inspect --channel channel.json --reserve 10
node packages/cli/dist/index.js claim preview --channel channel.json --amount 500 --fee 10
node packages/cli/dist/index.js claim submit --channel channel.json --transaction <hex> --dry-run
node packages/cli/dist/index.js refund preview --channel channel.json --now-daa 1000
node packages/cli/dist/index.js refund submit --channel channel.json --transaction <hex> --dry-run
```

`vectors verify` is the conformance entrypoint. It verifies schemas, payment vectors, x402 header encodings, voucher and channel digests, transaction-v1 fixtures, compute-budget fixtures, negative vectors, and the covenant fixture reproducibility report.

Channel inspection reports the stable covenant id plus Alpha.10 `A/S/T/V/R` accounting and remaining headroom. `R` is the advertised successor-reserve policy value supplied to the CLI with `--reserve`; it is not persisted or signed channel state. Claim and refund previews are local inspections of supplied JSON. Claims may preview a partial gross amount with `--amount`; claim fees are deducted from the provider payout, while the covenant successor decreases by the full gross claim. Refund readiness requires the current DAA score to be greater than the transaction lock time. These commands are not replacements for authoritative outpoint checks, transaction construction, consensus validation, or broadcast verification.

Submit commands are dry-run only until a production broadcaster adapter is explicitly wired. They validate operator intent and input shape without broadcasting transactions.

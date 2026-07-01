# @kaspa-x402/cli

CLI tools for conformance vectors, channel inspection, claim preview, claim execution, and refund workflows.

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
node packages/cli/dist/index.js upto inspect --payment payment.json
node packages/cli/dist/index.js upto settle --payment payment.json --charge-amount 0
node packages/cli/dist/index.js channel inspect --channel channel.json
node packages/cli/dist/index.js claim preview --channel channel.json
node packages/cli/dist/index.js claim submit --channel channel.json --transaction <hex> --dry-run
node packages/cli/dist/index.js refund preview --channel channel.json --now-daa 1000
node packages/cli/dist/index.js refund submit --channel channel.json --transaction <hex> --dry-run
```

`vectors verify` is the conformance entrypoint. It verifies schemas, payment vectors, x402 header encodings, voucher and channel digests, upto authorization and settlement vectors, transaction-v1 fixtures, compute-budget fixtures, negative vectors, and the covenant fixture reproducibility report.

`upto settle` includes a schema-valid `settlement` object only for zero-charge settlement. Nonzero charges require a server transaction builder plus an independent settlement transaction verifier, so the CLI returns a verifier-required preview instead of a successful settlement response.

Claim and refund previews are local inspections of supplied JSON. They report local arithmetic and missing evidence; they are not a replacement for server-side channel state checks, transaction construction, or broadcast verification.

Submit commands are dry-run only until a production broadcaster adapter is explicitly wired. They validate operator intent and input shape without broadcasting transactions.

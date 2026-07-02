# Paid HTTP API

Runnable mock HTTP API flow protected by Kaspa x402 direct mode.

```sh
npm run build
node examples/paid-http-api/index.mjs
```

The script runs two protected routes:

- `/download`: fixed-price `exact` payment;
- `/metered`: repeated `batch-settlement` calls that reuse the same escrow channel after the first call.

The mock environment uses deterministic fake funding, fake chain state, and fake signatures. It is intended for SDK integration shape and conformance behavior only; it does not broadcast transactions or require secrets.

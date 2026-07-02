# Recovery

Runnable mock recovery scenarios for Kaspa x402 direct mode.

```sh
npm run build
node examples/recovery/index.mjs
```

The script demonstrates:

- client state lost: the local material needed to continue a channel;
- server state lost: the request material needed to rebuild channel state;
- exact transaction replay rejection;
- corrective 402 metadata with channel and voucher state;
- refund preview after the refund timeout.

The script does not broadcast transactions. It is a failure-behavior walkthrough for operators before live deployments.

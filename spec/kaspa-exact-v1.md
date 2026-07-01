# Kaspa x402 Exact Binding v1

Status: draft

This document defines a proposed Kaspa network binding for x402 v2 `exact`.

## Summary

`exact` is for fixed-price one-shot purchases. The server knows the required amount before the request is served, and the client pays that exact amount for that request.

Examples:

- buy a file;
- buy one API response;
- call one fixed-price MCP tool.

## Identifier

```json
{
  "scheme": "exact",
  "network": "kaspa:<network>",
  "asset": "KAS",
  "extra": {
    "binding": "kaspa-exact-v1"
  }
}
```

Supported networks:

```text
kaspa:mainnet
kaspa:testnet-10
```

## Payment Requirements

```json
{
  "scheme": "exact",
  "network": "kaspa:testnet-10",
  "amount": "25000000",
  "asset": "KAS",
  "payTo": "kaspatest:...",
  "maxTimeoutSeconds": 60,
  "extra": {
    "binding": "kaspa-exact-v1"
  }
}
```

`amount` is the exact payment amount in sompi. `payTo` is the recipient Kaspa address.

## Payment Payload

The initial payload type is `exact-transfer`.

```json
{
  "type": "exact-transfer",
  "payerAddress": "kaspatest:...",
  "transaction": "<serialized transaction hex>",
  "requestHash": "<optional request fingerprint hex>"
}
```

The transaction may be submitted by the client before retry, by the resource server, or by a facilitator. In all cases the verifier must inspect the transaction rather than trusting declared payload fields.

## Verification

A verifier must reject if:

- `scheme` is not `exact`;
- `network` is not supported;
- `asset` is not `KAS`;
- `amount` is not a decimal sompi string;
- `payTo` is not a valid address for the selected network;
- the transaction is malformed or for the wrong network;
- the transaction does not contain exactly one payment output to `payTo` with value equal to `amount`;
- the transaction attempts to satisfy a different resource or payment requirement when `requestHash` or a payment identifier is required;
- the transaction has already been accepted for another x402 payment.

Change outputs are allowed. Additional outputs to `payTo` are not allowed unless the binding later defines an explicit batching extension.

## Settlement

Settlement broadcasts or observes the payment transaction and returns the transaction id:

```json
{
  "success": true,
  "transaction": "<kaspa transaction id>",
  "network": "kaspa:testnet-10",
  "payer": "kaspatest:...",
  "amount": "25000000"
}
```

The resource server chooses its finality policy. For low-value resources, accepting mempool visibility may be acceptable. Higher-value resources should require stronger confirmation policy in local server configuration.

## Toccata Notes

The `exact` binding does not require a covenant. It may use an ordinary native Kaspa transaction.

If future exact flows use covenant-assisted sponsorship, they must still satisfy the x402 `exact` property: the payment outcome for the request is exactly the required amount to the required recipient.

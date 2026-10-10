import NodeWebSocket from "ws";

/** ws enforces maxPayload on frames and reassembled messages before EventTarget delivery. */
export function createNodeBoundedPnnWebSocket(endpoint: string, maxBytes = 4_259_840): WebSocket {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4_259_840)
    throw new Error("PNN transport limit is invalid");
  return new NodeWebSocket(endpoint, {
    maxPayload: maxBytes,
    perMessageDeflate: false,
  }) as unknown as WebSocket;
}

Object.defineProperty(createNodeBoundedPnnWebSocket,
  Symbol.for("kaspa-x402:bounded-pnn-websocket:v1"), { value: true });

/** Read a remote JSON body without letting fetch or a body stream buffer without a limit. */
export async function readBoundedJsonResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) ||
      !Number.isSafeInteger(Number(declared)) || Number(declared) > maxBytes))
    throw new Error(`grant response declared length exceeds ${maxBytes} bytes`);
  if (!response.body) throw new Error("grant response body is missing");
  const reader = response.body.getReader();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("grant response aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error(`grant response exceeds ${maxBytes} bytes`);
      parts.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

export async function readBoundedResponseText(
  response,
  { maxBytes, tooLargeMessage },
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive safe integer");
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    BigInt(declaredLength) > BigInt(maxBytes)
  ) {
    throw new Error(tooLargeMessage);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return text + decoder.decode();
    bytes += chunk.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error(tooLargeMessage);
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
}

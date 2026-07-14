#!/usr/bin/env node
import fs from "node:fs";

const DEFAULT_GATEWAY_URL = "https://demo.kaspa-x402.org";
const MAX_RESPONSE_BYTES = 256 * 1024;

async function main() {
  const command = process.argv[2] ?? "stats";
  const gatewayUrl =
    option("--gateway") ??
    process.env.KASPA_X402_DEMO_GATEWAY_URL ??
    DEFAULT_GATEWAY_URL;
  const adminToken =
    option("--admin-token") ?? process.env.KASPA_X402_DEMO_ADMIN_TOKEN;
  if (!adminToken)
    throw new Error("Set KASPA_X402_DEMO_ADMIN_TOKEN or pass --admin-token.");

  if (command === "stats" || command === "list") {
    const result = await requestJson(
      gatewayUrl,
      "/admin/exact-heads",
      adminToken,
    );
    console.log(
      JSON.stringify(command === "stats" ? result.stats : result, null, 2),
    );
    return;
  }

  if (command === "register") {
    const file = option("--file") ?? process.env.KASPA_X402_EXACT_HEADS_FILE;
    if (!file)
      throw new Error(
        "Pass --file <heads.json> or set KASPA_X402_EXACT_HEADS_FILE.",
      );
    const input = JSON.parse(
      file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(file, "utf8"),
    );
    const body = Array.isArray(input)
      ? { records: input }
      : input.records || input.record
        ? input
        : { record: input };
    const result = await requestJson(
      gatewayUrl,
      "/admin/exact-heads/register",
      adminToken,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`Unknown command ${command}. Use stats, list, or register.`);
}

async function requestJson(baseUrl, path, adminToken, init = {}) {
  const response = await fetch(new URL(path, normalizedBaseUrl(baseUrl)), {
    ...init,
    headers: {
      authorization: `Bearer ${adminToken}`,
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const text = await readTextWithLimit(response);
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `Gateway returned non-JSON response ${response.status}: ${text.slice(0, 200)}`,
    );
  }
  if (!response.ok || body?.ok === false) {
    throw new Error(
      `Gateway request failed ${response.status}: ${body?.error ?? text.slice(0, 200)}`,
    );
  }
  return body;
}

async function readTextWithLimit(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return text + decoder.decode();
    bytes += chunk.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES)
      throw new Error("Gateway response is too large.");
    text += decoder.decode(chunk.value, { stream: true });
  }
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value.`);
  return value;
}

function normalizedBaseUrl(value) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return `${url.toString().replace(/\/$/, "")}/`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

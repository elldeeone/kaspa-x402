#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readBoundedResponseText } from "./read-bounded-response.mjs";

const DEFAULT_GATEWAY_URL = "https://demo.kaspa-x402.org";
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

async function main() {
  if (
    process.argv.some(
      (argument) =>
        argument === "--admin-token" || argument.startsWith("--admin-token="),
    )
  ) {
    throw new Error(
      "--admin-token is not accepted because process arguments are observable; set KASPA_X402_DEMO_ADMIN_TOKEN instead.",
    );
  }
  const command = process.argv[2] ?? "stats";
  const gatewayUrl =
    option("--gateway") ??
    process.env.KASPA_X402_DEMO_GATEWAY_URL ??
    DEFAULT_GATEWAY_URL;
  const adminToken = process.env.KASPA_X402_DEMO_ADMIN_TOKEN;
  if (!adminToken) throw new Error("Set KASPA_X402_DEMO_ADMIN_TOKEN.");

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

  if (command === "reconcile") {
    const headId = option("--head-id");
    if (!headId) throw new Error("Pass --head-id <64-hex-head-id>.");
    const transactionList = option("--transactions");
    const candidateTransactionIds = transactionList
      ? transactionList.split(",").map((value) => value.trim())
      : [];
    if (candidateTransactionIds.some((value) => value.length === 0))
      throw new Error(
        "--transactions must be an ordered comma-separated transaction-id list.",
      );
    const result = await requestJson(
      gatewayUrl,
      "/admin/exact-heads/reconcile",
      adminToken,
      {
        method: "POST",
        body: JSON.stringify({ headId, candidateTransactionIds }),
      },
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(
    `Unknown command ${command}. Use stats, list, register, or reconcile.`,
  );
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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await readBoundedResponseText(response, {
    maxBytes: MAX_RESPONSE_BYTES,
    tooLargeMessage: "Gateway response is too large.",
  });
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

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value.`);
  return value;
}

export function normalizedBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("Gateway URL must use HTTPS or loopback HTTP.");
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol === "http:" && !loopback) {
    throw new Error(
      "Refusing to send the admin bearer token over non-loopback HTTP.",
    );
  }
  if (url.username || url.password)
    throw new Error("Gateway URL must not contain credentials.");
  url.hash = "";
  url.search = "";
  return `${url.toString().replace(/\/$/, "")}/`;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

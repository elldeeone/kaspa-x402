// Build first: npm --workspace @kaspa-x402/demo-gateway run build
// Local workerd + SQLite only; synthetic attempts never reach a chain adapter.
// --stress fills 512 MiB of temporary SQLite and runs five minutes of mixed load.
// KASPA_X402_GATEWAY_STRESS_MS may shorten the run for a development preflight.
// --crash SIGKILLs only this harness's workerd child before handler recovery.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readlink, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

const persist = await mkdtemp(`${tmpdir()}/gateway-recovery-`);
const token = "ab".repeat(32); // Disposable local test credential.
const now = new Date().toISOString();
const stress = process.argv.includes("--stress");
const crash = process.argv.includes("--crash");
let runtime;
let outboundCalls = 0;
const options = {
  modules: true,
  scriptPath: fileURLToPath(new URL("../packages/demo-gateway/dist/index.js", import.meta.url)),
  compatibilityDate: "2026-06-02",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { GATEWAY_STATE: { className: "GatewayState", useSQLite: true } },
  resourcePersistencePath: persist,
  ratelimits: {
    GATEWAY_RATE_LIMIT: { namespace_id: "4021101", simple: { limit: 60, period: 60 } },
    ADMIN_RATE_LIMIT: { namespace_id: "4021102", simple: { limit: 10, period: 60 } },
  },
  bindings: {
    KASPA_X402_GATEWAY_ENABLED: "true",
    KASPA_X402_NETWORK: "kaspa:testnet-10",
    KASPA_X402_CHAIN_API_BASE: "https://api-tn10.kaspa.org",
    KASPA_X402_ADMIN_TOKEN: token,
    KASPA_X402_PAY_TO: "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh",
    KASPA_X402_SERVER_PUBLIC_KEY: "bee817fbf708b7ad2b12530bcc99e285805ab64faeea22f6d31e2bbcb164edf9",
  },
  outboundService() {
    outboundCalls++;
    return new Response("unexpected outbound request", { status: 503 });
  },
};

if (stress) {
  const disk = await statfs(persist);
  assert(disk.bavail * disk.bsize > 2 * 1024 ** 3, "stress check requires 2 GiB free disk");
  // Local-only subclass: fill actual SQLite without changing the production guard.
  const production = await readFile(options.scriptPath, "utf8");
  options.script = production.replace("export {\n  GatewayState,", "export {\n  StressGatewayState as GatewayState,") + `
class StressGatewayState extends GatewayState {
  async fetch(request) {
    if (new URL(request.url).pathname === "/__test-fill") {
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS stress_padding (value BLOB)");
      while (this.ctx.storage.sql.databaseSize < 512 * 1024 * 1024)
        this.ctx.storage.sql.exec("INSERT INTO stress_padding VALUES (zeroblob(1048576))");
      return Response.json({ok:true,value:{databaseSize:this.ctx.storage.sql.databaseSize}});
    }
    if (new URL(request.url).pathname === "/__test-size")
      return Response.json({ok:true,value:{databaseSize:this.ctx.storage.sql.databaseSize}});
    return super.fetch(request);
  }
}`;
  assert(options.script.includes("StressGatewayState as GatewayState"), "Worker export layout changed");
  delete options.scriptPath;
}

async function state(method, payload, route = "/") {
  const namespace = await runtime.getDurableObjectNamespace("GATEWAY_STATE");
  const stub = namespace.get(namespace.idFromName("demo-gateway-alpha.11"));
  const response = await stub.fetch(`http://state${route}`, {
    method: "POST", body: JSON.stringify({ method, payload }),
  });
  return response.json();
}

async function admin(route, body, auth = token, ip = "203.0.113.8") {
  return runtime.dispatchFetch(`https://local.test/admin/exact-settlements/${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  });
}

const attempts = Array.from({ length: 65 }, (_, index) => ({
  transactionId: (index + 1).toString(16).padStart(64, "0"),
  profile: "standard-native", amount: "10000000", paymentOutputIndex: 0,
  requestFingerprint: "11".repeat(32), paymentRequirementsHash: "22".repeat(32),
  paymentPayloadHash: "33".repeat(32), requestAuthorizationId: "44".repeat(32),
  payToScriptPublicKey: "0000" + "99".repeat(34), transaction: "synthetic-local-attempt",
  requiredFinality: "accepted", status: "pending", createdAt: now, updatedAt: now,
}));

try {
  runtime = new Miniflare(options);
  const claims = await Promise.all(attempts.map(record => state("claimExactSettlement", { record })));
  assert.equal(claims.filter(result => result.ok && result.value.created).length, 64);
  const blockedIndex = claims.findIndex(result => !result.ok);
  assert.match(claims[blockedIndex].error, /capacity/);
  const admitted = attempts.filter((_, index) => claims[index].ok);
  const blocked = attempts[blockedIndex];
  await runtime.dispose();
  runtime = new Miniflare(options);
  for (const record of admitted) {
    const replay = await state("claimExactSettlement", { record });
    assert.equal(replay.ok, true);
    assert.equal(replay.value.created, false);
  }
  assert.match((await state("claimExactSettlement", { record: blocked })).error, /capacity/);
  const rejected = admitted[0];
  const rejection = { transactionId: rejected.transactionId, reason: "synthetic trusted rejection", confirmedFinalRejection: true };
  assert.equal((await admin("reject", rejection, "wrong")).status, 401);
  assert.equal((await admin("reject", { ...rejection, confirmedFinalRejection: false })).status, 400);
  assert.match((await state("claimExactSettlement", { record: blocked })).error, /capacity/);
  assert.equal((await admin("reject", rejection)).status, 200);
  assert.equal((await state("claimExactSettlement", { record: blocked })).value.created, true);
  assert.equal((await state("acceptExactSettlement", { transactionId: blocked.transactionId, finality: "accepted", observedAt: now })).ok, true);
  assert.equal((await state("beginExactHandler", { transactionId: blocked.transactionId, startedAt: now })).ok, true);
  if (crash) await killOwnedWorkerd();
  await runtime.dispose();
  runtime = new Miniflare(options);
  if (crash) {
    for (const record of admitted.slice(1))
      assert.equal((await state("claimExactSettlement", { record })).value.created, false);
    assert.match((await state("claimExactSettlement", { record: { ...blocked, transactionId: "fc".repeat(32) } })).error, /capacity/);
  }
  const uncertain = await state("loadExactSettlementAttempt", { transactionId: blocked.transactionId });
  assert.equal(uncertain.value.handlerStartedAt, now);
  assert.equal(uncertain.value.handlerResult, undefined);
  assert.equal((await state("beginExactHandler", { transactionId: blocked.transactionId, startedAt: now })).value, false);
  const complete = await admin("complete", { transactionId: blocked.transactionId, handlerResult: { body: "operator confirmed local result" } });
  assert.equal(complete.status, 200, await complete.text());
  assert.equal((await state("loadExactSettlementAttempt", { transactionId: blocked.transactionId })).value.status, "applied");
  const replacement = { ...blocked, transactionId: "ff".repeat(32) };
  assert.equal((await state("claimExactSettlement", { record: replacement })).value.created, true);
  assert.match((await state("claimExactSettlement", { record: { ...replacement, transactionId: "fe".repeat(32) } })).error, /capacity/);
  const rateResponses = await Promise.all(Array.from({ length: 61 }, () => runtime.dispatchFetch("https://local.test/metrics", {
    headers: { "cf-connecting-ip": "203.0.113.7" },
  })));
  assert.equal(rateResponses.filter(response => response.status === 200).length, 60);
  assert.equal(rateResponses.filter(response => response.status === 429).length, 1);
  if (stress) await stressRecovery(admitted[1], replacement);
  assert.equal(outboundCalls, 0);
  console.log(JSON.stringify({ ok: true, runtime: "local workerd SQLite", concurrentClaims: 65,
    admitted: 64, capacityRejected: 1, runtimeRestarts: 2, persistedReplayChecks: 64,
    abruptWorkerdTerminations: crash ? 1 : 0,
    operatorRejection: true, operatorCompletionAfterHandlerRestart: true,
    concurrentRateRequests: 61, rateAllowed: 60, rateRejected: 1, outboundCalls }, null, 2));
} finally {
  await runtime?.dispose();
  await rm(persist, { recursive: true, force: true });
}

async function killOwnedWorkerd() {
  const children = (await readFile(`/proc/${process.pid}/task/${process.pid}/children`, "utf8")).trim().split(/\s+/).filter(Boolean);
  const owned = [];
  for (const child of children) {
    const executable = await readlink(`/proc/${child}/exe`).catch(() => "");
    if (executable.endsWith("/workerd")) owned.push(Number(child));
  }
  assert.equal(owned.length, 1, "expected exactly one direct workerd child; refusing to kill any other process");
  const pid = owned[0];
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  assert.equal(Number(status.match(/^PPid:\s+(\d+)/m)?.[1]), process.pid);
  process.kill(pid, "SIGKILL");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const alive = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
    if (!alive) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("owned workerd did not exit after SIGKILL");
}

async function stressRecovery(recoverable, admitted) {
  const durationMs = Number(process.env.KASPA_X402_GATEWAY_STRESS_MS ?? 300_000);
  assert(Number.isSafeInteger(durationMs) && durationMs >= 1000 && durationMs <= 600_000);
  const rejected = { ...admitted, transactionId: "fd".repeat(32) };
  assert.equal((await state("acceptExactSettlement", { transactionId: recoverable.transactionId, finality: "accepted", observedAt: now })).ok, true);
  assert.equal((await state("beginExactHandler", { transactionId: recoverable.transactionId, startedAt: now })).value, true);
  const size = await state("", {}, "/__test-fill");
  assert(size.value.databaseSize >= 512 * 1024 ** 2);
  const abuse = await Promise.all(Array.from({ length: 30 }, () => admin("reject", {
    transactionId: admitted.transactionId, reason: "untrusted", confirmedFinalRejection: true,
  }, "wrong", "203.0.113.99")));
  assert.equal(abuse.filter(response => response.status === 401).length, 10);
  assert.equal(abuse.filter(response => response.status === 429).length, 20);
  assert.equal((await state("loadExactSettlementAttempt", { transactionId: admitted.transactionId })).value.status, "pending");
  const started = Date.now();
  let nextRestart = started + 60_000;
  let nextProgress = started + 30_000;
  let restarts = 0;
  let interruptedRequests = 0;
  let peakRssBytes = 0;
  const latencies = [];
  const counts = { existingReplays: 0, storageRejected: 0, handlerRerunsRefused: 0, monitoringReads: 0 };
  while (Date.now() - started < durationMs) {
    await Promise.all(Array.from({ length: 16 }, async (_, index) => {
      const tick = performance.now();
      if (index % 4 === 0) {
        const result = await state("claimExactSettlement", { record: admitted });
        assert.equal(result.value?.created, false); counts.existingReplays++;
      } else if (index % 4 === 1) {
        const result = await state("claimExactSettlement", { record: rejected });
        assert.match(result.error, /storage admission limit/); counts.storageRejected++;
      } else if (index % 4 === 2) {
        assert.equal((await state("beginExactHandler", { transactionId: recoverable.transactionId, startedAt: now })).value, false);
        counts.handlerRerunsRefused++;
      } else {
        assert.equal((await state("metrics")).ok, true); counts.monitoringReads++;
      }
      latencies.push(performance.now() - tick);
    }));
    if (Date.now() >= nextRestart) {
      const outstanding = Array.from({ length: 16 }, () => state("claimExactSettlement", { record: admitted }));
      const settled = Promise.allSettled(outstanding);
      await runtime.dispose();
      interruptedRequests += (await settled).filter(result => result.status === "rejected").length;
      runtime = new Miniflare(options); restarts++;
      assert((await state("", {}, "/__test-size")).value.databaseSize >= 512 * 1024 ** 2);
      assert.equal((await state("loadExactSettlementAttempt", { transactionId: recoverable.transactionId })).value.handlerStartedAt, now);
      nextRestart = Date.now() + 60_000;
    }
    peakRssBytes = Math.max(peakRssBytes, await treeRss(process.pid));
    if (Date.now() >= nextProgress) {
      console.log(JSON.stringify({ stressProgressSeconds: Math.round((Date.now() - started) / 1000), operations: latencies.length, restarts }));
      nextProgress = Date.now() + 30_000;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const complete = await admin("complete", { transactionId: recoverable.transactionId, handlerResult: { body: "confirmed after storage ceiling and load" } }, token, "203.0.113.100");
  assert.equal(complete.status, 200, await complete.text());
  assert.equal((await state("loadExactSettlementAttempt", { transactionId: recoverable.transactionId })).value.status, "applied");
  assert.match((await state("claimExactSettlement", { record: rejected })).error, /storage admission limit/);
  assert.equal((await state("loadExactSettlementAttempt", { transactionId: rejected.transactionId })).value, undefined);
  const health = await runtime.dispatchFetch("https://local.test/health");
  assert.equal(health.status, 200);
  latencies.sort((left, right) => left - right);
  console.log(JSON.stringify({ storageStress: true, ok: true, databaseBytes: size.value.databaseSize,
    elapsedMs: Date.now() - started, concurrency: 16, operations: latencies.length, counts,
    restarts, interruptedRequests, authAbuse: { unauthorized: 10, rateLimited: 20 },
    latencyMs: { p50: latencies[Math.floor(latencies.length * .5)], p95: latencies[Math.floor(latencies.length * .95)], max: latencies.at(-1) },
    peakProcessTreeRssBytes: peakRssBytes, recoveryAboveStorageCeiling: true, outboundCalls }, null, 2));
}

async function treeRss(pid) {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const children = (await readFile(`/proc/${pid}/task/${pid}/children`, "utf8")).trim().split(/\s+/).filter(Boolean);
    return Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024 +
      (await Promise.all(children.map(treeRss))).reduce((sum, bytes) => sum + bytes, 0);
  } catch { return 0; }
}

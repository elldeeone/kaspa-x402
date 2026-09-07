import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MemoryChannelStore } from "@kaspa-x402/client";
import {
  persistExactPaymentAttempt,
  loadPersistedExactPaymentAttempts,
  withExactPaymentStoreLock,
  persistBatchRecoveryRecord,
} from "./live-adapter-reference.mjs";

// Offline process-loss checks of reference helpers, not a production ChannelStore.
const self = fileURLToPath(import.meta.url);
const children = new Set();
const hex = (value) => value.repeat(64);
const record = {
  format: "kaspa-x402-exact-provider-attempt-v1",
  attemptId: hex("a"), intentHash: hex("b"),
  result: { transactionId: hex("c"), transaction: "aabbcc" },
  reservedOutpoints: [{ txid: hex("d"), index: 0 }],
};
const channel = {
  id: hex("1"), covenantId: hex("2"), activeOutpoint: { txid: hex("3"), index: 0 },
  activeScriptPublicKey: "0000", fundingAmount: "100", status: "active",
};
const attempt = {
  channelId: channel.id, covenantId: channel.covenantId,
  activeOutpoint: channel.activeOutpoint, activeScriptPublicKey: channel.activeScriptPublicKey,
  fundingAmount: "100", channelStatus: "active", refundAmount: "100",
  transaction: "aabb", transactionId: hex("4"), status: "pending",
};
const snapshot = { clientChannels: [channel], attempt };

function checkpoint(stage) {
  fs.writeSync(3, `${JSON.stringify({ checkpoint: stage })}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

async function child(mode, directory, stage) {
  if (mode === "exact" || mode === "snapshot") {
    let syncs = 0;
    for (const name of ["writeFileSync", "fsyncSync", "linkSync", "renameSync"]) {
      const original = fs[name];
      fs[name] = (...args) => {
        const result = original(...args);
        const current = name === "fsyncSync" ? `fsync-${++syncs}` : name;
        if (current === stage) checkpoint(stage);
        return result;
      };
    }
    if (mode === "exact") persistExactPaymentAttempt(directory, record);
    else persistBatchRecoveryRecord(directory, "refund-before-broadcast", snapshot);
  } else if (mode === "reload") {
    const spent = new Set();
    const loaded = loadPersistedExactPaymentAttempts(directory, spent);
    const saved = loaded.get(record.attemptId);
    if (saved) assert.deepEqual(saved, record);
    process.send({ count: loaded.size, reserved: spent.size, result: saved?.result });
  } else if (mode === "lock") {
    try {
      await withExactPaymentStoreLock(directory, async () => {
        if (stage === "hold") checkpoint("lock");
        persistExactPaymentAttempt(directory, record);
      });
      process.send({ admitted: true });
    } catch (error) {
      if (!/exact payment store is locked/.test(error.message)) throw error;
      process.send({ admitted: false });
    }
  } else if (mode === "snapshot-writer") {
    const saved = JSON.parse(fs.readFileSync(path.join(directory, "batch-recovery/race.json")));
    fs.writeSync(3, `${JSON.stringify({ checkpoint: "snapshot-read" })}\n`);
    await new Promise((resolve) => process.once("message", resolve));
    persistBatchRecoveryRecord(directory, "race", { ...saved, [stage]: true });
    process.send({ wrote: stage });
  } else if (mode === "refund") {
    const saved = JSON.parse(fs.readFileSync(path.join(directory, "batch-recovery/refund-before-broadcast.json")));
    const store = new MemoryChannelStore(saved.clientChannels, [saved.attempt]);
    assert.deepEqual(await store.loadRefundAttempt(channel.id), attempt);
    await assert.rejects(store.claimRefundAttempt(attempt), /already pending/);
    await assert.rejects(store.saveChannel({ ...channel, fundingAmount: "200" }), /open refund/);
    await assert.rejects(store.applyRefundAttempt({ channelId: channel.id, transactionId: hex("5"), finality: "accepted" }), /does not match/);
    await assert.rejects(store.applyRefundAttempt({ channelId: channel.id, transactionId: attempt.transactionId, finality: "broadcast" }), /accepted finality/);
    assert.throws(() => new MemoryChannelStore([{ ...channel, fundingAmount: "200" }], [attempt]), /does not match/);
    const request = { channelId: channel.id, transactionId: attempt.transactionId, finality: "accepted" };
    const applied = await store.applyRefundAttempt(request);
    assert.equal(applied.channel.status, "refunded");
    assert.equal(applied.attempt.status, "applied");
    assert.deepEqual(await store.applyRefundAttempt(request), applied);
    process.send({ restoredArtifact: true, uncertaintyBlocksReuse: true, badEvidenceRejected: true, staleSnapshotRejected: true, applyIdempotent: true });
  }
}

function launch(mode, directory, stage = "") {
  const processChild = fork(self, ["--child", mode, directory, stage], { stdio: ["ignore", "ignore", "pipe", "pipe", "ipc"] });
  let errors = "";
  processChild.stderr.on("data", (chunk) => { errors += chunk; });
  let message;
  processChild.on("message", (value) => { message = value; });
  const done = new Promise((resolve, reject) => {
    processChild.on("error", reject);
    processChild.on("exit", (code, signal) => code === 0 || signal === "SIGKILL" ? resolve({ code, signal, message }) : reject(new Error(errors || `child exited ${code}`)));
  });
  const ready = new Promise((resolve) => processChild.stdio[3].once("data", (data) => resolve(JSON.parse(data.toString()))));
  const timeout = setTimeout(() => processChild.kill("SIGKILL"), 15_000);
  const running = { processChild, done, ready };
  children.add(running);
  done.finally(() => children.delete(running)).catch(() => {});
  done.finally(() => clearTimeout(timeout)).catch(() => {});
  return running;
}

async function killAt(mode, directory, stage) {
  const running = launch(mode, directory, stage);
  const arrived = await Promise.race([running.ready, running.done.then(() => { throw new Error(`checkpoint ${stage} not reached`); })]);
  assert.equal(arrived.checkpoint, stage === "hold" ? "lock" : stage);
  assert.equal(running.processChild.kill("SIGKILL"), true);
  assert.equal((await running.done).signal, "SIGKILL");
}

if (process.argv[2] === "--child") {
  await child(...process.argv.slice(3));
  process.disconnect();
} else {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "x402-client-persistence-"));
  const evidence = { scope: "reference file helpers and MemoryChannelStore reload; process loss only; no network or funds", filesystemType: fs.statfsSync(directory).type, checks: [] };
  try {
    for (const stage of ["writeFileSync", "fsync-1", "linkSync", "fsync-2"]) {
      const target = path.join(directory, stage);
      await killAt("exact", target, stage);
      const result = await launch("reload", target).done;
      const visible = stage === "linkSync" || stage === "fsync-2";
      assert.equal(result.message.count, visible ? 1 : 0);
      assert.equal(result.message.reserved, visible ? 1 : 0);
      if (visible) assert.deepEqual(result.message.result, record.result);
      evidence.checks.push({ exactCrashAt: stage, committed: visible, freshProcessReload: true });
    }
    const target = path.join(directory, "competing");
    const holder = launch("lock", target, "hold");
    await Promise.race([holder.ready, holder.done.then(() => { throw new Error("lock checkpoint not reached"); })]);
    assert.equal((await launch("lock", target).done).message.admitted, false);
    holder.processChild.kill("SIGKILL");
    assert.equal((await holder.done).signal, "SIGKILL");
    assert.equal((await launch("lock", target).done).message.admitted, false);
    // Only our terminated child's lock inside our private test directory is removed.
    fs.rmSync(path.join(target, "exact-payment-attempts/.provider.lock"));
    assert.equal((await launch("lock", target).done).message.admitted, true);
    assert.equal((await launch("reload", target).done).message.count, 1);
    evidence.checks.push({ competingWriterBlocked: true, killedOwnerFailsClosed: true, explicitDeadOwnerRecovery: true });
    const raceDirectory = path.join(directory, "snapshot-race");
    persistBatchRecoveryRecord(raceDirectory, "race", { base: true });
    const writers = ["first", "second"].map((name) => launch("snapshot-writer", raceDirectory, name));
    await Promise.all(writers.map((writer) => Promise.race([writer.ready, writer.done.then(() => { throw new Error("snapshot checkpoint not reached"); })])));
    writers[0].processChild.send("write");
    await writers[0].done;
    writers[1].processChild.send("write");
    await writers[1].done;
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(raceDirectory, "batch-recovery/race.json"))), { base: true, second: true });
    evidence.checks.push({ referenceSnapshotLostUpdateReproduced: true, staleCompetingWriterOverwrites: true });
    for (const stage of ["writeFileSync", "renameSync"]) {
      const target = path.join(directory, `snapshot-${stage}`);
      persistBatchRecoveryRecord(target, "refund-before-broadcast", { old: true });
      await killAt("snapshot", target, stage);
      const saved = JSON.parse(fs.readFileSync(path.join(target, "batch-recovery/refund-before-broadcast.json")));
      assert.deepEqual(saved, stage === "writeFileSync" ? { old: true } : snapshot);
      if (stage === "renameSync") evidence.checks.push({ refundReload: (await launch("refund", target).done).message });
      evidence.checks.push({ snapshotCrashAt: stage, completeOldOrNewRecord: true });
    }
    evidence.limitations = ["No durable transactional client ChannelStore exists in repository", "Reference batch snapshot helper has no fsync or compare-and-set; last writer wins", "Refund apply checks use MemoryChannelStore, not shared durable transactions", "No power-loss or hosted storage durability claim", "Exact helper journal reload checks artifact identity; does not invoke wallet construction or broadcast"];
    const output = process.argv.indexOf("--report");
    if (output >= 0) fs.writeFileSync(process.argv[output + 1], `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    const remaining = [...children];
    for (const child of remaining) child.processChild.kill("SIGKILL");
    await Promise.allSettled(remaining.map((child) => child.done));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSettlementResponse } from "@kaspa-x402/core";
import { describe, expect, it } from "vitest";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(packageDir, "../..");
const cli = path.join(packageDir, "dist", "index.js");

describe("kaspa-x402 CLI", () => {
  it("prints top-level and command help", () => {
    expect(run("--help")).toContain("vectors verify");
    expect(run("exact", "inspect", "--help")).toContain("kaspa-x402 exact inspect");
  });

  it("verifies the conformance vectors", () => {
    const report = JSON.parse(run("vectors", "verify", "--root", root, "--json")) as {
      ok: boolean;
      schemas: number;
      vectors: number;
      covenantFixtureChecks: number;
    };

    expect(report.ok).toBe(true);
    expect(report.schemas).toBeGreaterThan(0);
    expect(report.vectors).toBeGreaterThan(0);
    expect(report.covenantFixtureChecks).toBeGreaterThan(0);
  });

  it("inspects and verifies exact payloads", () => {
    const fixture = readJson("vectors/x402-http/exact-transfer.json") as {
      paymentRequired: unknown;
      paymentPayload: unknown;
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kaspa-x402-cli-"));
    const payment = path.join(dir, "payment.json");
    const requirements = path.join(dir, "required.json");
    fs.writeFileSync(payment, JSON.stringify(fixture.paymentPayload));
    fs.writeFileSync(requirements, JSON.stringify(fixture.paymentRequired));

    const inspect = JSON.parse(run("exact", "inspect", "--payment", payment, "--json")) as { scheme: string };
    const verify = JSON.parse(run("exact", "verify", "--payment", payment, "--requirements", requirements, "--json")) as {
      ok: boolean;
      scheme: string;
    };

    expect(inspect.scheme).toBe("exact");
    expect(verify).toMatchObject({ ok: true, scheme: "exact" });
  });

  it("plans upto settlement responses", () => {
    const fixture = readJson("vectors/upto/authorization.json") as {
      paymentPayload: unknown;
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kaspa-x402-cli-"));
    const payment = path.join(dir, "upto.json");
    fs.writeFileSync(payment, JSON.stringify(fixture.paymentPayload));

    const zero = JSON.parse(run("upto", "settle", "--payment", payment, "--charge-amount", "0", "--json")) as {
      action: string;
      settlement: {
        success: boolean;
        transaction: string;
        amount?: string;
        extra?: {
          chargedAmount?: string;
        };
      };
    };
    const nonzero = JSON.parse(run("upto", "settle", "--payment", payment, "--charge-amount", "100", "--json")) as {
      action: string;
      settlementReady: boolean;
      requestedChargeAmount: string;
    };

    expect(zero.action).toBe("upto-settle-zero-charge");
    expect(zero.settlement).toMatchObject({ success: true, transaction: "" });
    expect(zero.settlement.amount).toBeUndefined();
    expect(zero.settlement.extra?.chargedAmount).toBe("0");
    expect(validateSettlementResponse(zero.settlement).ok).toBe(true);
    expect(nonzero).toMatchObject({
      action: "upto-settle-preview",
      settlementReady: false,
      requestedChargeAmount: "100",
    });
    expect("success" in nonzero).toBe(false);
  });

  it("keeps claim and refund previews local and evidence-aware", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kaspa-x402-cli-"));
    const impossible = path.join(dir, "impossible-channel.json");
    const coherent = path.join(dir, "coherent-channel.json");
    fs.writeFileSync(
      impossible,
      JSON.stringify({
        id: "11".repeat(32),
        status: "active",
        fundingAmount: "100",
        chargedCumulativeAmount: "150",
        claimedCumulativeAmount: "0",
        signedMaxClaimable: "150",
        voucherSignature: "22".repeat(64),
        refundTimeoutDaa: "10",
      }),
    );
    fs.writeFileSync(
      coherent,
      JSON.stringify({
        id: "33".repeat(32),
        status: "active",
        fundingAmount: "1000",
        chargedCumulativeAmount: "100",
        claimedCumulativeAmount: "0",
        signedMaxClaimable: "100",
        voucherSignature: "44".repeat(64),
        refundTimeoutDaa: "10",
      }),
    );

    const claim = JSON.parse(run("claim", "preview", "--channel", impossible, "--json")) as {
      claimable: boolean | string;
      localChecksPassed: boolean;
      continuationAmount: string | null;
      reasons: string[];
    };
    const refundMissingDaa = JSON.parse(run("refund", "preview", "--channel", coherent, "--json")) as {
      refundable: boolean | string;
      localChecksPassed: boolean;
      reasons: string[];
    };
    const refundReady = JSON.parse(run("refund", "preview", "--channel", coherent, "--now-daa", "10", "--json")) as {
      refundable: boolean | string;
      localChecksPassed: boolean;
      reasons: string[];
    };

    expect(claim.claimable).toBe(false);
    expect(claim.localChecksPassed).toBe(false);
    expect(claim.continuationAmount).toBeNull();
    expect(claim.reasons).toContain("active_claim_exceeds_funding_amount");
    expect(refundMissingDaa.refundable).toBe(false);
    expect(refundMissingDaa.reasons).toContain("now_daa_required");
    expect(refundReady.localChecksPassed).toBe(true);
    expect(refundReady.refundable).toBe("unknown");
    expect(refundReady.reasons).toEqual([]);
  });

  it("rejects inconsistent upto payloads before settlement preview", () => {
    const fixture = readJson("vectors/upto/authorization.json") as {
      paymentPayload: {
        accepted: { amount: string };
        payload: {
          authorization: {
            maxAmountSompi: string;
          };
        };
      };
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kaspa-x402-cli-"));
    const payment = path.join(dir, "bad-upto.json");
    const malformed = structuredClone(fixture.paymentPayload);
    malformed.payload.authorization.maxAmountSompi = (BigInt(malformed.accepted.amount) + 1n).toString();
    fs.writeFileSync(payment, JSON.stringify(malformed));

    const result = runFailure("upto", "settle", "--payment", payment, "--charge-amount", "0", "--json");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("upto authorization maximum does not match accepted amount");
  });
});

function run(...args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function runFailure(...args: string[]): { status: number | null; stderr: string } {
  try {
    execFileSync(process.execPath, [cli, ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stderr: "" };
  } catch (error) {
    const failed = error as { status?: number | null; stderr?: string | Buffer };
    return {
      status: failed.status ?? null,
      stderr: Buffer.isBuffer(failed.stderr) ? failed.stderr.toString("utf8") : (failed.stderr ?? ""),
    };
  }
}

function readJson(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const root = path.resolve(packageDir, "../..");
const cli = path.join(packageDir, "dist", "index.js");

describe("kaspa-x402 CLI", () => {
  it("prints top-level and command help", () => {
    expect(run("--help")).toContain("vectors verify");
    expect(run("exact", "inspect", "--help")).toContain(
      "kaspa-x402 exact inspect",
    );
  });

  it("verifies the conformance vectors", () => {
    const report = JSON.parse(
      run("vectors", "verify", "--root", root, "--json"),
    ) as {
      ok: boolean;
      schemas: number;
      vectors: number;
      covenantFixtureChecks: number;
    };

    expect(report.ok).toBe(true);
    expect(report.schemas).toBeGreaterThan(0);
    expect(report.vectors).toBeGreaterThan(0);
    expect(report.covenantFixtureChecks).toBeGreaterThanOrEqual(22);
  });

  it("treats --root as data and never imports validator code from it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kaspa-x402-root-"));
    const marker = path.join(dir, "executed");
    fs.mkdirSync(path.join(dir, "scripts"));
    fs.writeFileSync(
      path.join(dir, "scripts", "validate-schemas.mjs"),
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "executed");`,
    );
    for (const name of ["schemas", "vectors", "contracts"]) {
      fs.symlinkSync(path.join(root, name), path.join(dir, name), "dir");
    }

    const report = JSON.parse(
      run("vectors", "verify", "--root", dir, "--json"),
    ) as { ok: boolean };
    expect(report.ok).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("inspects and verifies exact payloads", () => {
    const fixture = readJson("vectors/x402-http/exact-transaction.json") as {
      paymentRequired: unknown;
      paymentPayload: unknown;
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kaspa-x402-cli-"));
    const payment = path.join(dir, "payment.json");
    const requirements = path.join(dir, "required.json");
    fs.writeFileSync(payment, JSON.stringify(fixture.paymentPayload));
    fs.writeFileSync(requirements, JSON.stringify(fixture.paymentRequired));

    const inspect = JSON.parse(
      run("exact", "inspect", "--payment", payment, "--json"),
    ) as { scheme: string };
    const verify = JSON.parse(
      run(
        "exact",
        "verify",
        "--payment",
        payment,
        "--requirements",
        requirements,
        "--json",
      ),
    ) as {
      ok: boolean;
      scheme: string;
    };

    expect(inspect.scheme).toBe("exact");
    expect(verify).toMatchObject({ ok: true, scheme: "exact" });
  });

  it("keeps claim and refund previews local and evidence-aware", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kaspa-x402-cli-"));
    const impossible = path.join(dir, "impossible-channel.json");
    const coherent = path.join(dir, "coherent-channel.json");
    fs.writeFileSync(
      impossible,
      JSON.stringify({
        channelId: "11".repeat(32),
        covenantId: "12".repeat(32),
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
        channelId: "33".repeat(32),
        covenantId: "34".repeat(32),
        status: "active",
        fundingAmount: "1000",
        chargedCumulativeAmount: "100",
        claimedCumulativeAmount: "0",
        signedMaxClaimable: "100",
        voucherSignature: "44".repeat(64),
        refundTimeoutDaa: "10",
      }),
    );

    const claim = JSON.parse(
      run("claim", "preview", "--channel", impossible, "--json"),
    ) as {
      claimable: boolean | string;
      localChecksPassed: boolean;
      continuationAmount: string | null;
      reasons: string[];
    };
    const refundMissingDaa = JSON.parse(
      run("refund", "preview", "--channel", coherent, "--json"),
    ) as {
      refundable: boolean | string;
      localChecksPassed: boolean;
      reasons: string[];
    };
    const refundAtTimeout = JSON.parse(
      run(
        "refund",
        "preview",
        "--channel",
        coherent,
        "--now-daa",
        "10",
        "--json",
      ),
    ) as {
      refundable: boolean | string;
      localChecksPassed: boolean;
      reasons: string[];
    };
    const refundReady = JSON.parse(
      run(
        "refund",
        "preview",
        "--channel",
        coherent,
        "--now-daa",
        "11",
        "--json",
      ),
    ) as {
      refundable: boolean | string;
      localChecksPassed: boolean;
      reasons: string[];
    };

    expect(claim.claimable).toBe(false);
    expect(claim.localChecksPassed).toBe(false);
    expect(claim.continuationAmount).toBeNull();
    expect(claim.reasons).toContain("invalid_batch_lane_accounting");
    expect(refundMissingDaa.refundable).toBe(false);
    expect(refundMissingDaa.reasons).toContain("now_daa_required");
    expect(refundAtTimeout.refundable).toBe(false);
    expect(refundAtTimeout.reasons).toContain("refund_timeout_not_elapsed");
    expect(refundReady.localChecksPassed).toBe(true);
    expect(refundReady.refundable).toBe("unknown");
    expect(refundReady.reasons).toEqual([]);
  });

  it("shows Alpha.11 lane accounting and previews a partial claim", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kaspa-x402-cli-"));
    const channelPath = path.join(dir, "channel.json");
    const fullyAuthorizedPath = path.join(dir, "fully-authorized.json");
    fs.writeFileSync(
      channelPath,
      JSON.stringify({
        channelId: "55".repeat(32),
        covenantId: "56".repeat(32),
        status: "active",
        activeOutpoint: { txid: "57".repeat(32), index: 1 },
        activeScriptPublicKey: `0000${"58".repeat(32)}`,
        fundingAmount: "1000",
        chargedCumulativeAmount: "100",
        claimedCumulativeAmount: "20",
        signedMaxClaimable: "150",
        voucherSignature: "59".repeat(64),
        refundTimeoutDaa: "100",
      }),
    );
    fs.writeFileSync(
      fullyAuthorizedPath,
      JSON.stringify({
        channelId: "65".repeat(32),
        covenantId: "66".repeat(32),
        status: "active",
        activeOutpoint: { txid: "67".repeat(32), index: 1 },
        activeScriptPublicKey: `0000${"68".repeat(32)}`,
        fundingAmount: "100",
        chargedCumulativeAmount: "95",
        claimedCumulativeAmount: "0",
        signedMaxClaimable: "95",
        voucherSignature: "69".repeat(64),
        refundTimeoutDaa: "100",
      }),
    );

    const inspect = JSON.parse(
      run(
        "channel",
        "inspect",
        "--channel",
        channelPath,
        "--reserve",
        "10",
        "--json",
      ),
    ) as {
      covenantId: string;
      accounting: Record<string, string | null>;
    };
    const claim = JSON.parse(
      run(
        "claim",
        "preview",
        "--channel",
        channelPath,
        "--amount",
        "30",
        "--fee",
        "10",
        "--json",
      ),
    ) as {
      localChecksPassed: boolean;
      previewClaimAmount: string;
      providerPayoutAmount: string;
      continuationAmount: string;
      continuationClaimedCumulativeAmount: string;
      remainingVoucherAuthorization: string;
    };
    const fullyAuthorized = JSON.parse(
      run(
        "claim",
        "preview",
        "--channel",
        fullyAuthorizedPath,
        "--amount",
        "95",
        "--fee",
        "10",
        "--json",
      ),
    ) as {
      localChecksPassed: boolean;
      providerPayoutAmount: string;
      continuationAmount: string;
    };

    expect(inspect.covenantId).toBe("56".repeat(32));
    expect(inspect.accounting).toMatchObject({
      A: "100",
      S: "20",
      T: "150",
      V: "1000",
      R: "10",
      outstandingActualCharge: "80",
      remainingVoucherAuthorization: "130",
      authorizationHeadroom: "870",
      reserveHeadroom: "860",
    });
    expect(claim).toMatchObject({
      localChecksPassed: true,
      previewClaimAmount: "30",
      providerPayoutAmount: "20",
      continuationAmount: "970",
      continuationClaimedCumulativeAmount: "50",
      remainingVoucherAuthorization: "100",
    });
    expect(fullyAuthorized).toMatchObject({
      localChecksPassed: true,
      providerPayoutAmount: "85",
      continuationAmount: "5",
    });
  });
});

function run(...args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function readJson(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

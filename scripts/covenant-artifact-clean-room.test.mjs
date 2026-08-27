import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync("contracts/kaspa-x402-escrow-v3.sil");
const fixture = JSON.parse(
  fs.readFileSync("contracts/fixtures/kaspa-x402-escrow-v3.json", "utf8"),
);

test("published artifacts reconstruct genesis and successor without project packages", () => {
  assert.equal(sha256(source), fixture.sourceSha256);

  const genesis = renderRedeemScript(fixture.sample.params);
  assert.equal(genesis, fixture.sample.genesis.redeemScript);
  assert.equal(
    sha256(Buffer.from(genesis, "hex")),
    fixture.sample.genesis.bytecodeSha256,
  );

  const successor = renderRedeemScript({
    ...fixture.sample.params,
    settledTotal: fixture.sample.successor.settledTotal,
  });
  assert.equal(successor, fixture.sample.successor.redeemScript);
  assert.equal(
    sha256(Buffer.from(successor, "hex")),
    fixture.sample.successor.bytecodeSha256,
  );
});

function renderRedeemScript(params) {
  const layout = fixture.constructorLayout;
  assert.equal(layout.format, "fixed-width-byte-patches-v1");
  const script = Buffer.from(fixture.sample.genesis.redeemScript, "hex");
  assert.equal(script.length, layout.redeemScriptBytes);

  for (const slot of layout.slots) {
    const value = encodeSlot(slot, params);
    assert.equal(value.length, slot.bytes, `${slot.name} byte length`);
    for (const offset of slot.offsets) {
      assert.ok(offset >= 0 && offset + slot.bytes <= script.length);
      value.copy(script, offset);
    }
  }
  return script.toString("hex");
}

function encodeSlot(slot, params) {
  if (slot.name === "networkHash") {
    return crypto.createHash("sha256").update(params.network, "utf8").digest();
  }
  if (slot.encoding === "hex") return Buffer.from(params[slot.name], "hex");
  if (slot.encoding === "signed-int64-le") {
    const value = BigInt(params[slot.name]);
    assert.ok(value >= 0n && value <= 0x7fff_ffff_ffff_ffffn);
    const result = Buffer.alloc(8);
    result.writeBigInt64LE(value);
    return result;
  }
  throw new Error(`unsupported constructor encoding: ${slot.encoding}`);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

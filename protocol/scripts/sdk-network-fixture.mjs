import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/** Controlled wallet/chain fixture with the SDK's real native address codec. */
export function writeNetworkFixture(sourceRoot, destination, network, { facilitator = true } = {}) {
  if (!["kaspa:mainnet", "kaspa:testnet-10"].includes(network)) throw Error("unsupported fixture network");
  const ts = createRequire(path.join(sourceRoot, "package.json"))("typescript");
  const native = fs.readFileSync(path.join(sourceRoot, "packages/adapters/src/kaspa-native.ts"), "utf8");
  fs.writeFileSync(path.join(path.dirname(destination), "sdk-native-address.mjs"), ts.transpileModule(native, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
  let source = fs.readFileSync(path.join(sourceRoot, "examples/lib/mock-direct-mode.mjs"), "utf8");
  const codec = /class MockAddressCodec \{[\s\S]*?\n\}/;
  if (!codec.test(source)) throw Error("network fixture address codec is missing");
  source = 'import { encodeScriptAddress as nativeEncodeScriptAddress, scriptPublicKeyForAddress as nativeScriptPublicKeyForAddress } from "./sdk-native-address.mjs";\n' +
    source.replace(codec, `class MockAddressCodec {
  scriptPublicKeyForAddress(address, network) {
    // Wallet keys/observations are controlled; derived escrow addresses use the
    // real native decoder, including its checksum and network-prefix checks.
    if (address === PAYOUT_ADDRESS || address === REFUND_ADDRESS)
      return "0000" + sha256Hex(network + ":" + address);
    return nativeScriptPublicKeyForAddress(address, network);
  }
  encodeScriptAddress(input) { return nativeEncodeScriptAddress(input); }
}`);
  if (!facilitator) source = source.replace('import { DirectModeFacilitator } from "@kaspa-x402/facilitator";', "")
    .replace("const facilitator = new DirectModeFacilitator({ server });", "const facilitator = undefined;");
  if (network === "kaspa:mainnet") source = source.replaceAll('"kaspa:testnet-10"', '"kaspa:mainnet"')
    .replaceAll("kaspatest:", "kaspa:")
    .replaceAll("new DirectModeServer({", "new DirectModeServer({ allowMainnet: true,")
    .replaceAll("new DirectModeClient({", "new DirectModeClient({ allowMainnet: true,")
    .replaceAll("new DirectModeFacilitator({", "new DirectModeFacilitator({ allowMainnet: true,");
  fs.writeFileSync(destination, source);
}

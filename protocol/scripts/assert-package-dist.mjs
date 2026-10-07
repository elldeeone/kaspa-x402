import { existsSync } from "node:fs";
import { join } from "node:path";

const requiredFiles = ["dist/index.js", "dist/index.d.ts"];
const missing = requiredFiles.filter((file) => !existsSync(join(process.cwd(), file)));

if (missing.length > 0) {
  console.error(`package build output is missing: ${missing.join(", ")}. Run npm run build before packing or publishing.`);
  process.exit(1);
}

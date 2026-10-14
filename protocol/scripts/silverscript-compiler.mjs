import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SILVERSCRIPT_COMMIT = "3ed973335b59269293564805cc2c58a14595ec03";
const TOOLCHAIN = "1.95.0";
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/** Mutable checkout files, Git replacement refs, ambient Cargo config and caches
 * are not compiler inputs. The host's installed Git/Rust toolchain remains trusted.
 */
export function withPinnedSilverScript(input, callback) {
  if (!input) throw new Error("Set SILVERSCRIPT_DIR or pass the pinned SilverScript checkout path.");
  const repository = fs.realpathSync(path.resolve(input));
  const toolEnvironment = trustedToolEnvironment();
  const gitEnvironment = { ...toolEnvironment, GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull, GIT_NO_REPLACE_OBJECTS: "1" };
  const git = (...args) => run("git", ["-C", repository, ...args], { env: gitEnvironment });
  const gitRoot = fs.realpathSync(git("rev-parse", "--show-toplevel").toString().trim());
  if (repository !== gitRoot) throw new Error("SilverScript checkout root must equal its Git top-level.");
  if (git("rev-parse", "HEAD").toString().trim() !== SILVERSCRIPT_COMMIT)
    throw new Error(`SilverScript checkout must be at ${SILVERSCRIPT_COMMIT}.`);
  const commit = readObject("commit", SILVERSCRIPT_COMMIT);
  const tree = /^tree ([0-9a-f]{40})\n/.exec(commit.toString())?.[1];
  if (!tree) throw new Error("Pinned SilverScript commit has no valid tree.");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kaspa-x402-silverc-"));
  const sourceRoot = path.join(temporary, "source");
  const cargoHome = path.join(temporary, "cargo-home");
  const target = path.join(temporary, "target");
  const contracts = path.join(temporary, "contracts");
  const files = [];
  const capturedSources = new Map();
  const compilations = [];
  let totalBytes = 0;
  let executable;
  let build;
  try {
    for (const directory of [sourceRoot, cargoHome, contracts]) fs.mkdirSync(directory, { mode: 0o700 });
    exportTree(tree, "");
    const manifest = fs.readFileSync(path.join(sourceRoot, "Cargo.toml"));
    const lock = fs.readFileSync(path.join(sourceRoot, "Cargo.lock"));
    const cargoEnvironment = { ...toolEnvironment, CARGO_HOME: cargoHome, RUSTUP_TOOLCHAIN: TOOLCHAIN };
    // Cargo searches configuration from cwd, not --manifest-path. Avoid every
    // mutable checkout/temp ancestor; reject root configuration rather than use it.
    const cargoCwd = path.parse(sourceRoot).root;
    for (const name of ["config", "config.toml"])
      if (fs.existsSync(path.join(cargoCwd, ".cargo", name)))
        throw new Error("Root Cargo configuration is incompatible with isolated compiler builds.");
    const session = {
      commit: SILVERSCRIPT_COMMIT,
      compile(source, constructorValues) {
        const captured = captureSource(source);
        if (!executable) {
          const cargoVersion = run("cargo", ["--version"], { cwd: cargoCwd, env: cargoEnvironment }).toString().trim();
          const rustcVersion = run("rustc", ["-Vv"], { cwd: cargoCwd, env: cargoEnvironment }).toString().trim();
          if (!cargoVersion.startsWith(`cargo ${TOOLCHAIN} `) || !rustcVersion.startsWith(`rustc ${TOOLCHAIN} `))
            throw new Error(`Pinned SilverScript builds require Cargo and rustc ${TOOLCHAIN}.`);
          run("cargo", ["build", "--locked", "--manifest-path", path.join(sourceRoot, "Cargo.toml"),
            "-p", "silverscript-lang", "--bin", "silverc", "--jobs", "2", "--target-dir", target],
          { cwd: cargoCwd, env: cargoEnvironment, stdio: ["pipe", "pipe", "inherit"] });
          if (!fs.readFileSync(path.join(sourceRoot, "Cargo.lock")).equals(lock))
            throw new Error("Compiler build changed the authenticated Cargo.lock.");
          executable = path.join(target, "debug", process.platform === "win32" ? "silverc.exe" : "silverc");
          const stat = fs.lstatSync(executable);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Compiled silverc must be a regular file.");
          build = { cargoVersion, rustcVersion, compilerBinarySha256: sha256(fs.readFileSync(executable)),
            command: "cargo build --locked --manifest-path <pinned-source>/Cargo.toml -p silverscript-lang --bin silverc --jobs 2 --target-dir <private-target>" };
        }
        const constructorBytes = Buffer.from(JSON.stringify(constructorValues));
        const constructorFile = path.join(contracts, `constructor-${compilations.length}.json`);
        fs.writeFileSync(constructorFile, constructorBytes, { flag: "wx", mode: 0o600 });
        const output = run(executable, [captured.file, "--constructor-args", constructorFile, "-c"],
          { cwd: cargoCwd, env: cargoEnvironment });
        compilations.push({ source: path.basename(source), sourceSha256: sha256(captured.bytes),
          constructorSha256: sha256(constructorBytes), outputSha256: sha256(output) });
        return JSON.parse(output);
      },
      sourceSha256(source) { return sha256(captureSource(source).bytes); },
      provenance() {
        return { compilerCommit: SILVERSCRIPT_COMMIT, compilerTree: tree,
          sourceManifestSha256: sha256(Buffer.from(JSON.stringify(files))),
          cargoManifestSha256: sha256(manifest), cargoLockSha256: sha256(lock),
          ...build, compilations: [...compilations] };
      },
    };
    return callback(session);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }

  function readObject(type, oid) {
    const bytes = git("cat-file", type, oid);
    const actual = crypto.createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
    if (actual !== oid) throw new Error(`SilverScript ${type} object does not match its authenticated ID.`);
    return bytes;
  }
  function exportTree(oid, prefix) {
    const bytes = readObject("tree", oid);
    let offset = 0;
    while (offset < bytes.length) {
      const space = bytes.indexOf(32, offset), zero = bytes.indexOf(0, space);
      if (space < 0 || zero < 0 || zero + 21 > bytes.length) throw new Error("Invalid compiler Git tree.");
      const mode = bytes.subarray(offset, space).toString();
      const nameBytes = bytes.subarray(space + 1, zero);
      const name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
      const objectId = bytes.subarray(zero + 1, zero + 21).toString("hex");
      offset = zero + 21;
      if (!name || [".", "..", ".git"].includes(name.toLowerCase()) || /[\\/:\0]/.test(name))
        throw new Error("Unsafe path in pinned compiler tree.");
      const relative = prefix ? `${prefix}/${name}` : name;
      const file = path.join(sourceRoot, relative);
      if (mode === "40000") {
        fs.mkdirSync(file, { mode: 0o700 }); exportTree(objectId, relative);
      } else {
        if (!["100644", "100755"].includes(mode)) throw new Error("Compiler symlinks and gitlinks are not supported.");
        const content = readObject("blob", objectId);
        totalBytes += content.length;
        if (files.length >= 10_000 || totalBytes > 128 * 1024 * 1024) throw new Error("Compiler snapshot exceeds its input budget.");
        fs.writeFileSync(file, content, { flag: "wx", mode: mode === "100755" ? 0o700 : 0o600 });
        files.push({ path: relative, gitBlob: objectId, sha256: sha256(content) });
      }
    }
  }
  function captureSource(source) {
    if (capturedSources.has(source)) return capturedSources.get(source);
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Covenant source must be a regular file.");
    const bytes = fs.readFileSync(source);
    const file = path.join(contracts, path.basename(source));
    fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
    const captured = { file, bytes }; capturedSources.set(source, captured); return captured;
  }
}

function trustedToolEnvironment() {
  // HOME is retained for rustup's installation lookup, never changed. Cargo uses
  // a newly created CARGO_HOME; no user cache/config or build overrides survive.
  return Object.fromEntries(["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "RUSTUP_HOME"]
    .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: null, maxBuffer: 128 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.toString() || result.stdout?.toString() || `${command} failed (${result.status ?? result.signal}).`);
  return result.stdout ?? Buffer.alloc(0);
}

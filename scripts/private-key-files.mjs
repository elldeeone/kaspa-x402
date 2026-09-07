import fs from "node:fs";
import path from "node:path";

export function assertPrivateKeyDirectory(directory) {
  const resolved = path.resolve(directory);
  if (fs.realpathSync(resolved) !== resolved) throw new Error("key directory cannot contain symlinks");
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077))
    throw new Error("key directory must be owned by the current user with mode 0700");
}

export function readPrivateKeyFile(file) {
  assertPrivateKeyDirectory(path.dirname(file));
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) || stat.size > 4096)
      throw new Error("key file must be private, owned by the current user, and a regular file at most 4096 bytes");
    return fs.readFileSync(fd, "utf8").trim();
  } finally { fs.closeSync(fd); }
}

export function writePrivateKeyFile(file, contents) {
  assertPrivateKeyDirectory(path.dirname(file));
  fs.writeFileSync(file, contents, { flag: "wx", mode: 0o600 });
}

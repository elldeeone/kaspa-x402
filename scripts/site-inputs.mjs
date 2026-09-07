export function isPublishableDirtyPath(file, inputs, releaseLockDirectory) {
  return (
    file === releaseLockDirectory ||
    file.startsWith(`${releaseLockDirectory}/`) ||
    inputs.has(file) ||
    [...inputs].some((input) => file.startsWith(`${input}/`))
  );
}
import fs from "node:fs";
import path from "node:path";

export function containedRegularFile(root, file) {
  const base = fs.realpathSync(root);
  const resolved = fs.realpathSync(path.resolve(root, file));
  const relative = path.relative(base, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("publication input escapes the repository");
  if (!fs.statSync(resolved).isFile()) throw new Error("publication input must be a regular file");
  return resolved;
}

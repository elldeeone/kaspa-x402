export function isPublishableDirtyPath(file, inputs, releaseLockDirectory) {
  return (
    file === releaseLockDirectory ||
    file.startsWith(`${releaseLockDirectory}/`) ||
    inputs.has(file) ||
    [...inputs].some((input) => file.startsWith(`${input}/`))
  );
}

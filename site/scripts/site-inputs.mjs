export function isPublishableDirtyPath(file, inputs) {
  return (
    inputs.has(file) ||
    [...inputs].some((input) => file.startsWith(`${input}/`))
  );
}

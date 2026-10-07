// Proof-only fees; SDK and wallet fee policies remain unchanged.
export function proofFeeSompi(name, fallback, maximum = 100_000_000n) {
  const value = process.env[name] ?? fallback;
  if (!/^[1-9][0-9]*$/.test(value) || BigInt(value) > maximum)
    throw new Error(`${name} must be a positive integer at most ${maximum} sompi`);
  return BigInt(value);
}

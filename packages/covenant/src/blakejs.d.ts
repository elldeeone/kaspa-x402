declare module "blakejs" {
  export function blake2b(input: Uint8Array, key?: Uint8Array, outlen?: number): Uint8Array;
}

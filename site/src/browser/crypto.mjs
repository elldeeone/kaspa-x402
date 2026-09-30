import { sha256 } from '@noble/hashes/sha2.js';
import { Buffer } from 'buffer';

// The existing payment helpers only use SHA-256 from node:crypto. Keep this
// adapter scoped to the demo bundle rather than changing the published SDK.
export default {
  createHash(algorithm) {
    if (algorithm !== 'sha256') throw new Error('Unsupported demo hash');
    const hash = sha256.create();
    return {
      update(value) {
        hash.update(typeof value === 'string' ? new TextEncoder().encode(value) : value);
        return this;
      },
      digest(encoding) {
        const bytes = Buffer.from(hash.digest());
        return encoding ? bytes.toString(encoding) : bytes;
      },
    };
  },
};

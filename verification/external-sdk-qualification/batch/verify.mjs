import { readFileSync as qualificationReadFileSync } from "node:fs";
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const r = JSON.parse(await fs.readFile(new URL('report.json', import.meta.url)));
assert.equal(r.base, JSON.parse(qualificationReadFileSync(new URL("../manifest.json", import.meta.url))).revision);
assert.equal(r.pass, 17);
assert.equal(r.fail, 0);
assert(r.tests.every(t => t.status === 'pass'));
assert.deepEqual(r.stress, { requests: 650, independentCharges: 221, expectedA: '22100', expectedS: '0', expectedV: '1000000', reserve: '10', handlers: 221 });
assert.equal(r.httpRequests, 701);
assert.equal(r.handlerCalls, 239);
const sums = (await fs.readFile(new URL('SHA256SUMS', import.meta.url), 'utf8')).trim().split('\n');
for (const row of sums) {
    const [sum, path] = row.split(/\s+/);
    const data = await fs.readFile(new URL(path, import.meta.url));
    assert.equal(createHash('sha256').update(data).digest('hex'), sum, path);
}
console.log('Batch report verified: 17 groups, 701 requests, 650-request seeded stress, archived source/artifact hashes.');

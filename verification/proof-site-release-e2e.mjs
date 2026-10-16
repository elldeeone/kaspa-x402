import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[process.argv.indexOf('--out') + 1] || '.kaspa-x402-live/site-release/report.json');
assert.ok(process.argv.includes('--out'), '--out is required');
fs.mkdirSync(path.dirname(out), { recursive: true });
const publicationStatus = JSON.parse(fs.readFileSync(path.join(root, "site/release.json"))).publicationStatus;
assert.ok(["candidate", "published"].includes(publicationStatus));
const cases = [];
async function check(name, fn) { try {
    const evidence = await fn();
    cases.push({ name, passed: true, evidence });
}
catch (error) {
    cases.push({ name, passed: false, error: error.message });
} }
const build = spawnSync('npm', ['run', 'site:build'], { cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
fs.writeFileSync(out + '.build.log', (build.stdout ?? '') + (build.stderr ?? ''));
assert.equal(build.status, 0, 'site build failed; see build log');
const reservation = net.createServer();
await new Promise(r => reservation.listen(0, '127.0.0.1', r));
const port = reservation.address().port;
await new Promise(r => reservation.close(r));
const preview = spawn(process.execPath, ['site/scripts/site-serve.mjs'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
const get = async (route) => { const response = await fetch(base + route, { signal: AbortSignal.timeout(5000) }); assert.equal(response.status, 200, route); return response; };
try {
    for (let i = 0; i < 60; i++) {
        try {
            await get('/');
            break;
        }
        catch {
            await new Promise(r => setTimeout(r, 100));
            if (i === 59)
                throw Error('preview did not start');
        }
    }
    const home = await (await get('/')).text();
    await check('metadata records SDK publication and the separate demo deployment', async () => {
        const r = await (await get('/release.json')).json();
        assert.equal(r.version, '1.0.0');
        assert.equal(r.channel, 'latest');
        assert.equal(r.publicationStatus, publicationStatus);
        assert.deepEqual(r.supportedNetworks, ['kaspa:testnet-10', 'kaspa:mainnet']);
        assert.equal(r.demo.version, publicationStatus === 'published' ? '1.0.0' : '1.0.0-rc.2');
        assert.equal(r.demo.network, 'kaspa:testnet-10');
        return r;
    });
    await check('homepage has honest publication status and exact install commands', async () => {
        if (publicationStatus === "candidate") {
            assert.match(home, /1\.0\.0 candidate/);
            assert.doesNotMatch(home, /<strong>1\.0\.0 released<\/strong>/);
            assert.match(home, /After publication/);
        } else {
            assert.match(home, /<strong>1\.0\.0 released<\/strong>/);
            assert.match(home, /Install the stable SDK/);
        }
        for (const name of ['core', 'covenant', 'client', 'server'])
            assert.ok(home.includes(`@kaspa-x402/${name}@1.0.0`));
        assert.doesNotMatch(home, /Install it with <code>@rc/);
        assert.match(home, /SDK supports/);
        const demoStatus = home.match(/<li>Hosted demo:[\s\S]*?<\/li>/)?.[0];
        assert.ok(demoStatus);
        if (publicationStatus === 'published') {
            assert.match(demoStatus, /<code>1\.0\.0<\/code>/);
        } else assert.match(demoStatus, /1\.0\.0-rc\.2/);
        return { installPackages: 4 };
    });
    await check('release notes are published and linked', async () => {
        const notes = await (await get('/docs/v1-release/')).text();
        assert.match(notes, /1\.0\.0 release/);
        assert.match(await (await get('/docs/')).text(), /\/docs\/v1-release\//);
        assert.match(home, /\/docs\/v1-release\//);
    });
    await check('every generated page, asset link and fragment resolves over HTTP', async () => {
        const files = fs.readdirSync(path.join(root, 'site/dist'), { recursive: true }).filter(f => f.endsWith('.html') && f !== '404.html');
        const cache = new Map();
        let links = 0, fragments = 0;
        const failures = [];
        for (const file of files) {
            const route = '/' + file.replace(/index\.html$/, '');
            const html = await (await get(route)).text();
            for (const m of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
                const raw = m[1].replaceAll('&amp;', '&');
                const url = new URL(raw, base + route);
                if (url.origin !== base)
                    continue;
                const target = url.pathname;
                let body;
                try {
                    if (!cache.has(target))
                        cache.set(target, await (await get(target)).text());
                    body = cache.get(target);
                    links++;
                    if (url.hash) {
                        const id = decodeURIComponent(url.hash.slice(1));
                        assert.ok(body.includes(`id="${id}"`) || body.includes(`name="${id}"`), `${route} -> ${raw}`);
                        fragments++;
                    }
                }
                catch (e) {
                    failures.push(e.message);
                }
            }
        }
        assert.deepEqual(failures, []);
        return { pages: files.length, links, fragments };
    });
    await check('browser quote reader rejects old covenant before signing or funding', async () => {
        const { readHashChainQuote } = await import(pathToFileURL(path.join(root, 'site/dist/assets/hash-chain-client.js')));
        const vector = JSON.parse(fs.readFileSync(path.join(root, 'protocol/vectors/x402-http/hash-chain-exact.json')));
        const find = v => v && typeof v === 'object' ? (v.accepts ? v : Object.values(v).map(find).find(Boolean)) : undefined;
        const required = structuredClone(find(vector));
        assert.ok(required?.accepts);
        const quote = required.accepts.find(a => a.extra?.profile === 'hash-chain-additive');
        assert.ok(quote);
        quote.extra.templateId = 'kaspa-x402-hash-chain-head-v1';
        const response = new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(required)).toString('base64'), 'X-KASPA-X402-DEMO-CALLER': '11'.repeat(32) } });
        assert.throws(() => readHashChainQuote(response), /requires.*head-v2/);
        return { oldTemplateRejected: true, fundingOrSigningCalls: 0 };
    });
}
finally {
    preview.kill('SIGTERM');
}
const report = { revision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(), cases, passed: cases.filter(c => c.passed).length, failed: cases.filter(c => !c.passed).length, evidenceBoundary: 'Actual build and HTTP preview; controlled incompatible quote; separate browser and live read-only evidence retained outside this report.' };
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
fs.writeFileSync(out + '.sha256', crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex') + '\n');
console.log(JSON.stringify({ report: out, passed: report.passed, failed: report.failed }));
if (report.failed)
    process.exitCode = 1;

import assert from "node:assert/strict";
import test from "node:test";
import { createSiteMarkdown } from "./site-markdown.mjs";

const markdown = createSiteMarkdown((href, dir) =>
  href.endsWith(".md") ? `/${dir}/${href.slice(0, -3)}/` : href,
);

test("documentation renders emphasis across wrapped lines and ordered steps", () => {
  const html = markdown.render("**one accepted\ntransition** with *one-time keys*.\n\n1. Claim the grant.\n2. Pay.\n", "spec");
  assert.match(html, /<strong>one accepted\ntransition<\/strong>/);
  assert.match(html, /<em>one-time keys<\/em>/);
  assert.match(html, /<ol>\n<li>Claim the grant\.<\/li>\n<li>Pay\.<\/li>/);
});

test("literal code and HTML remain inert while links retain their destinations", () => {
  const html = markdown.render('`**literal**` and [**profile**](profile.md).\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n```json\n{"marker":"**"}\n```', "spec");
  assert.match(html, /<code>\*\*literal\*\*<\/code>/);
  assert.match(html, /<a href="\/spec\/profile\/">\s*<strong>profile<\/strong><\/a>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script|href="javascript:/);
  assert.match(html, /<pre><code class="language-json">\{&quot;marker&quot;:&quot;\*\*&quot;\}/);
});

test("headings provide stable unique fragments and tables preserve escaped pipes", () => {
  const html = markdown.render("## Private grant claim\n\n## Private grant claim\n\n| Value | Meaning |\n| --- | --- |\n| `a` | left \\| right |", "spec");
  assert.match(html, /id="private-grant-claim"/);
  assert.match(html, /id="private-grant-claim-1"/);
  assert.match(html, /<div class="table-wrap"><table>/);
  assert.match(html, /<td>left \| right<\/td>/);
});

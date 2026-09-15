const fs = require('fs');
const path = require('path');

const DIST = 'D:/vitepress/redesign/dist';
const ICON_DIR = 'D:/vitepress/redesign/assets/icons';
let fail = 0, warn = 0, checked = 0;

const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
  const p = path.join(d, e.name);
  return e.isDirectory() ? walk(p) : [p];
});

const htmls = walk(DIST).filter(f => f.endsWith('.html'));

for (const f of htmls) {
  const html = fs.readFileSync(f, 'utf8');
  const rel = path.relative(DIST, f);

  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const r = m[1];
    if (/^(https?:|mailto:|#|data:)/.test(r)) continue;
    checked++;
    const clean = r.split('#')[0].split('?')[0];
    if (!clean) continue;
    const target = clean.startsWith('/') ? path.join(DIST, clean) : path.resolve(path.dirname(f), clean);
    if (!fs.existsSync(target)) { console.log(`  FAIL ${rel} -> ${r}`); fail++; }
  }

  const need = [
    ['title', /<title>[^<]+<\/title>/],
    ['meta description', /name="description" content="[^"]+"/],
    ['canonical', /rel="canonical" href="https:\/\/www\.xihaouc\.top/],
    ['lang', /<html lang="zh-CN">/],
    ['styles.css', /assets\/styles\.css/],
    ['app.js', /assets\/app\.js/],
    ['ICP', /ICP备2025193604号/],
  ];
  for (const [label, re] of need) {
    if (!re.test(html)) { console.log(`  FAIL ${rel} missing ${label}`); fail++; }
  }

  const h1 = (html.match(/<h1[^>]*>/g) || []).length;
  if (h1 !== 1) { console.log(`  FAIL ${rel} h1 count=${h1}`); fail++; }
  if (html.includes('__R__')) { console.log(`  FAIL ${rel} unreplaced __R__`); fail++; }
  if (html.includes('undefined')) { console.log(`  WARN ${rel} contains undefined`); warn++; }

  for (const m of html.matchAll(/assets\/icons\/([^"]+)/g)) {
    if (!fs.existsSync(path.join(ICON_DIR, m[1]))) { console.log(`  FAIL ${rel} icon missing: ${m[1]}`); fail++; }
  }
}

const home = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const appLinks = new Set([...home.matchAll(/href="apps\/([^"]+)\.html"/g)].map(m => m[1]));
const appFiles = new Set(fs.readdirSync(path.join(DIST, 'apps')).map(f => f.replace('.html', '')));

const unreachable = [...appFiles].filter(s => !appLinks.has(s));
if (unreachable.length) { console.log(`  FAIL unreachable from home: ${unreachable.join(',')}`); fail++; }

for (const s of ['auto-jingling', 'legado']) {
  if (appFiles.has(s)) { console.log(`  FAIL excluded item present: ${s}`); fail++; }
  if (home.includes(`apps/${s}.html`)) { console.log(`  FAIL home links excluded: ${s}`); fail++; }
}

const sm = fs.readFileSync(path.join(DIST, 'sitemap.xml'), 'utf8');
const smLocs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
const expect = 1 + 1 + 6 + appFiles.size;
if (smLocs.length !== expect) { console.log(`  FAIL sitemap ${smLocs.length} != ${expect}`); fail++; }
for (const s of appFiles) {
  if (!smLocs.some(l => l.endsWith('/apps/' + s))) { console.log(`  FAIL sitemap missing: ${s}`); fail++; }
}

if (!fs.readFileSync(path.join(DIST, 'robots.txt'), 'utf8').includes('Sitemap:')) { console.log('  FAIL robots.txt'); fail++; }

console.log(`\nchecked ${htmls.length} html / ${checked} internal refs / ${appFiles.size} detail pages`);
console.log(fail ? `FAILED: ${fail}` : 'ALL PASS');
if (warn) console.log(`  (${warn} warnings)`);

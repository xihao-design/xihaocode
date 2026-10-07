/* ============================================================
   筛选核对：把**产物里的** assets/app.js 中 initSkillsFilter 原样取出来，
   配一个最小 DOM 桩（数据取自**真实构建产物**的 HTML），真的点每个 chip，核对筛出来的卡片。

   为什么不用无头浏览器点：浏览器能回答「页面长什么样」，但筛选的边界情形
   （同维度多选取并集、多值卡片、空结果、复位）用点击去穷举既慢又容易漏；
   这里跑的是产物里那段函数**本身**（不是照抄一份实现 —— 照抄只能证明我抄对了自己的想法），
   页面的 chip 与卡片也全从产物里读，所以「声明」与「行为」仍然是两回事，能互相打架。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');
const JS = path.join(DIST, 'assets', 'app.js');

let fail = 0;
const bad = msg => { console.log(`  FAIL ${msg}`); fail++; };
const ok = msg => console.log(`  ok   ${msg}`);

if (!fs.existsSync(JS)) {
  console.log('找不到 dist/assets/app.js —— 先跑 npm run build');
  process.exit(1);
}
const appjs = fs.readFileSync(JS, 'utf8');

/* ---------- 从产物里取出函数源码（大括号配对，不做任何改写）---------- */
function extract(name) {
  const start = appjs.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`产物里找不到 ${name}() —— 筛选器改名了？`);
  let depth = 0, i = appjs.indexOf('{', start);
  for (; i < appjs.length; i++) {
    if (appjs[i] === '{') depth++;
    else if (appjs[i] === '}') { depth--; if (depth === 0) break; }
  }
  return appjs.slice(start, i + 1);
}
const src = extract('initSkillsFilter');
ok(`取到产物里的 initSkillsFilter（${src.length} 字节）`);

/* ---------- 最小 DOM 桩 ---------- */
const el = (props = {}) => Object.assign({
  dataset: {}, hidden: false, attrs: {}, textContent: '', _l: {},
  setAttribute(k, v) { this.attrs[k] = String(v); },
  getAttribute(k) { return this.attrs[k]; },
  toggleAttribute(k, on) { if (on) this.attrs[k] = ''; else delete this.attrs[k]; },
  addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); },
  // 真浏览器里点击会冒泡到 #chips 容器（监听器装在容器上），桩必须照样冒泡，
  // 否则「点了 chip 没反应」是桩的错，会误导成页面有 bug。
  click() {
    const ev = { target: this, preventDefault() {} };
    (this._l.click || []).forEach(fn => fn(ev));
    if (this._parent) (this._parent._l.click || []).forEach(fn => fn(ev));
  },
  closest() { return this; },
}, props);

/** 从一份产物 HTML 里建出印章式的一页：chips + 卡片 + #shown/#empty/#reset */
function boot(html, chipsRe, cardsRe, search = '', hash = '') {
  const chipsRaw = [...html.matchAll(chipsRe)].map(m => ({ facet: m[1], n: Number(m[m.length - 1]) }));
  const cardsRaw = [...html.matchAll(cardsRe)].map(m => m[1]);
  if (!chipsRaw.length || !cardsRaw.length) return null;
  const box = el();
  const chips = chipsRaw.map(c => el({ dataset: { facet: c.facet }, _parent: box }));
  const cards = cardsRaw.map(f => el({ dataset: { facets: f, hay: '' } }));
  const grid = el(), showEl = el(), emptyEl = el({ hidden: true }), resetEl = el();
  const byId = { '#grid': grid, '#chips': box, '#q': null, '#clr': null, '#empty': emptyEl, '#shown': showEl, '#reset': resetEl };
  const $ = sel => byId[sel] || null;
  const $$ = (sel, root) => (root === box ? chips : root === grid ? cards : []);
  global.window = {};
  global.location = { search, pathname: '/', hash };
  new Function('$', '$$', 'window', 'location', src + '\nreturn initSkillsFilter;')($, $$, global.window, global.location)();
  const chipOf = v => chips.find(c => c.dataset.facet === v);
  return {
    chipsRaw, cardsRaw, chips, cards, showEl, emptyEl, resetEl, chipOf,
    visible: () => cards.filter(c => !c.hidden).map(c => c.dataset.facets),
    hiddenCount: () => cards.filter(c => c.hidden).length,
  };
}

const CHIP_RE = /<button class="chip" type="button" data-facet="([^"]*)"[^>]*>[^<]*<span class="chip__n">(\d+)<\/span>/g;
const CARD_RE = /<a class="card"[^>]*?data-facets="([^"]*)"/g;

/* ---------- 电脑软件页：平台维度（多值） ---------- */
const desktopFile = path.join(DIST, 'desktop', 'index.html');
if (!fs.existsSync(desktopFile)) {
  console.log('\n电脑软件页没产出（条目不够门槛），跳过它的平台筛选核对');
} else {
  const html = fs.readFileSync(desktopFile, 'utf8');
  console.log('\n电脑软件页 /desktop/ 平台筛选');
  const probe = boot(html, CHIP_RE, CARD_RE);
  if (!probe) bad('页面上没解析到 chips / 卡片，筛选器拿不到数据');
  else {
    const total = probe.cards.length;
    const union = values => probe.cardsRaw.filter(f => values.some(v => f.split(';').includes('plat=' + v)));

    // 1. 每个平台 chip 的计数 = 点下去真的能看到的卡片数（声明与行为必须一致）
    for (const c of probe.chipsRaw.filter(c => c.facet !== 'plat=*')) {
      const s = boot(html, CHIP_RE, CARD_RE);
      s.chipOf(c.facet).click();
      const got = s.visible().length, want = union([c.facet.slice(5)]).length;
      if (got !== c.n) bad(`点「${c.facet}」可见 ${got} 张，chip 上写的是 ${c.n}`);
      else if (got !== want) bad(`点「${c.facet}」可见 ${got} 张，按 facets 应为 ${want}`);
      else if (s.chipOf(c.facet).attrs['aria-pressed'] !== 'true') bad(`点「${c.facet}」后 aria-pressed 不是 true`);
      else if (s.hiddenCount() !== total - got) bad(`点「${c.facet}」后隐藏 ${s.hiddenCount()} 张，与可见数不互补`);
      else ok(`点「${c.facet}」→ ${got}/${total}，计数文案 ${JSON.stringify(s.showEl.textContent)}`);
    }

    // 2. 多值卡片：必须出现在它命中的每一个平台里（这正是要改匹配逻辑的原因）
    const multi = probe.cardsRaw.filter(f => f.split(';').length > 1);
    if (!multi.length) console.log('  note 本页没有多平台卡片，多值那条分支这次没被覆盖');
    for (const f of multi) {
      const values = f.split(';').map(kv => kv.slice(5));
      const miss = values.filter(v => {
        const s = boot(html, CHIP_RE, CARD_RE);
        s.chipOf('plat=' + v).click();
        return !s.visible().includes(f);
      });
      if (miss.length) bad(`多平台卡片「${f}」没出现在 ${miss.join('、')} 的筛选结果里（旧写法只会归到最后一个平台）`);
      else ok(`多平台卡片「${f}」在它命中的 ${values.length} 个平台筛选里都出现`);
    }

    // 3. 同维度多选取「或」（并集，不是交集）
    //    注意：count 要数**卡片**，不能数「不同的 facets 字符串」—— 页面上多张卡片的
    //    facets 完全一样（12 张都是 plat=Windows），用 Set 去重会把 14 张算成 2 张。
    const values = probe.chipsRaw.filter(c => c.facet !== 'plat=*').map(c => c.facet.slice(5));
    const unionCount = picked => probe.cardsRaw
      .filter(f => f.split(';').some(kv => picked.includes(kv.slice(5)))).length;
    let pairs = 0;
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        const picked = [values[i], values[j]];
        const s = boot(html, CHIP_RE, CARD_RE);
        s.chipOf('plat=' + picked[0]).click();
        s.chipOf('plat=' + picked[1]).click();
        const got = s.visible().length, want = unionCount(picked);
        if (got !== want) bad(`同选「${picked[0]}」+「${picked[1]}」可见 ${got} 张，并集应为 ${want} 张（取交集会得到更少）`);
        else pairs++;
      }
    }
    if (pairs) ok(`${pairs} 组平台两两同选，可见数都等于并集（取「或」而不是取交集）`);

    // 4. 深链带一个不存在的值（分享链接过期）→ 空状态 + 复位按钮必须能点
    const s = boot(html, CHIP_RE, CARD_RE, '?plat=__不存在的平台__');
    if (s.visible().length !== 0) bad('深链带不存在的平台值时仍有卡片可见');
    else if (s.emptyEl.hidden !== false) bad('空结果时没显示空状态（#empty 仍 hidden）');
    else {
      s.resetEl.click();
      if (s.visible().length !== total || s.emptyEl.hidden !== true) bad('点「清除筛选条件」后没有恢复全部卡片');
      else ok(`深链空结果 → 空状态可见、复位后恢复 ${total} 张`);
    }
  }
}

/* ---------- 技能库：单值维度（改动不能把它改坏） ---------- */
const skillsFile = path.join(DIST, 'skills', 'index.html');
if (!fs.existsSync(skillsFile)) {
  console.log('\n技能库页没产出，跳过回归');
} else {
  const html = fs.readFileSync(skillsFile, 'utf8');
  console.log('\n技能库 /skills/ 回归（单值维度）');
  const base = boot(html, CHIP_RE, CARD_RE);
  if (!base) bad('技能库页没解析到 chips / 卡片');
  else {
    let checked = 0;
    for (const c of base.chipsRaw.filter(c => !c.facet.endsWith('=*'))) {
      const s = boot(html, CHIP_RE, CARD_RE);
      s.chipOf(c.facet).click();
      const got = s.visible().length;
      const want = base.cardsRaw.filter(f => f.split(';').includes(c.facet)).length;
      if (got !== want || got !== c.n) bad(`技能库点「${c.facet}」可见 ${got} 张，chips 写 ${c.n}、按 facets 应 ${want}`);
      else checked++;
    }
    if (checked) ok(`${checked} 个单值 chip 逐项命中（${base.cards.length} 张卡片）`);
  }
}

console.log(fail ? `\n筛选核对 FAILED：${fail} 项` : '\n筛选核对 ALL PASS');
process.exit(fail ? 1 : 0);

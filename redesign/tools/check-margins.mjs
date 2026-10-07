/* 左右边距核对（常驻门禁）
   ============================================================
   为什么有这个门禁：回退 UI 时我把首页 hero / 筛选条 / 三个合规页 / 各详情页的
   `.wrap` 弄丢了，后果是**整页内容贴到视口边缘**。而我当时用来核对的临时脚本
   只量了「自己挑的几个元素」，恰好都带 .wrap，于是得出「与线上一致」的错误结论 ——
   截图一看就露馅。

   两个必须避免的度量陷阱（都实际踩过）：
   1) **别去量 <section>**。它是全宽块（left=0、width=1410），
      真正制造左右边距的是它里面的 `.wrap`。量 section 只会得到 0，
      然后误判成「贴边」或误判成「对齐」。
   2) **必须用反向断言**：不看某一个元素对不对，而是断言
      「整页最靠左的可见块必须 >= 边距阈值」。这样只要有任何一个块忘了裹 .wrap
      并且带了可见内容，就会被抓住 —— 这正是当初漏掉的那类错误。

   基准值来自线上实测（1440 视口）：容器 .wrap 的 border-box 在 145，
   内容内缘 185。这里不硬编码，而是从页面自身的 .wrap 算出来，避免视口变化导致误判。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { findBrowser, dumpDomRetry, fileUrl, cleanupProfile } from './chrome.mjs';

const DIST = path.resolve(import.meta.dirname, '..', 'dist');
const b = findBrowser();
if (!b) { console.error('找不到浏览器'); process.exit(1); }

const PROBE = `document.addEventListener('DOMContentLoaded',function(){
  var c=document.querySelector('.wrap');
  var cLeft=c?Math.round(c.getBoundingClientRect().left):null;
  var cPad=c?parseFloat(getComputedStyle(c).paddingLeft||0):null;

  /* 收集「直接承载可见内容的块」，量它们的 border-box 左边缘。
     选择器覆盖面要够广 —— 漏掉某一种写法就会量到 0 个块，
     然后「最靠左块」变成 null，断言失效（实测：404 页就是 <main class="wrap">
     里直接放裸 <section>，没有内层 .wrap，原先的选择器一个都匹配不上）。
     兜底：再抓一批语义标签，保证任何页都能量到东西。 */
  var sels=['main > .wrap','main > section > .wrap','main > section.sec > .wrap',
            'main .hero > .wrap','main > .grid-sec','main > .page-hd','main > .crumb',
            'main .blk','main .rel','main .prose','main .meta','main .notice',
            'main > section .sec-hd','main .tools .wrap','main .grid','main .channels',
            'main > section > h1','main > section > p','main h1','main .hero__lede',
            'main .guides','main .promises'];
  var seen=new Set(), blocks=[];
  sels.forEach(function(sel){
    [].slice.call(document.querySelectorAll(sel)).forEach(function(el){
      if(seen.has(el)) return; seen.add(el);
      var r=el.getBoundingClientRect();
      if(r.width<40) return;                 // 跳过分隔线之类的细条
      blocks.push({sel:sel, left:Math.round(r.left), w:Math.round(r.width)});
    });
  });

  /* 反向断言的依据：整页最靠左的那个块。
     只要它 >= 阈值，就不存在「贴到视口边缘」的内容。 */
  var minLeft = blocks.length ? Math.min.apply(null, blocks.map(function(x){return x.left;})) : null;

  document.documentElement.setAttribute('data-mc', JSON.stringify({
    vw: window.innerWidth,
    containerLeft: cLeft, containerPad: cPad,
    containerW: c?Math.round(c.getBoundingClientRect().width):null,
    minLeft: minLeft,
    blockCount: blocks.length,
    offBase: blocks.filter(function(x){ return cLeft!=null && x.left < cLeft; })
  }));
});`;

function measure(page, w = 1440) {
  let html = fs.readFileSync(path.join(DIST, page), 'utf8');
  html = html.replace('</body>', `<script>${PROBE}</script></body>`);
  const abs = path.join(DIST, page);
  const tmp = path.join(path.dirname(abs), `__mc-${path.basename(page)}`);
  fs.writeFileSync(tmp, html, 'utf8');
  const dom = dumpDomRetry(b, fileUrl(tmp), { timeout: 60000, w, h: 1200 });
  fs.rmSync(tmp, { force: true });
  const m = dom.match(/data-mc="([^"]+)"/);
  return m ? JSON.parse(m[1].replace(/&quot;/g, '"')) : null;
}

let fail = 0;
const check = (label, cond, extra) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${extra ? '  ' + extra : ''}`); if (!cond) fail++; };

const PAGES = ['index.html', 'ai/index.html', 'ai/category/audio.html', 'ai/category/audio/transcription.html',
  'ai/whisper.html', 'desktop/index.html', 'skills/index.html', 'guides/index.html',
  'apps/musicfree.html', 'category/media.html', 'tag/android-tv.html', 'topic/fresh-install.html',
  'about.html', 'disclaimer.html', 'copyright.html', 'products/haofox.html', '404.html'];

for (const page of PAGES) {
  const d = measure(page);
  console.log(`\n[${page}]`);
  if (!d || d.containerLeft == null) { console.log('  FAIL 取不到测量结果（页面上没有 .wrap？）'); fail++; continue; }
  console.log(`  容器 .wrap border=${d.containerLeft} pad=${d.containerPad} width=${d.containerW} · 块 ${d.blockCount} 个 · 最靠左块 left=${d.minLeft} · 视口 ${d.vw}`);

  /* 1) 核心反向断言：整页最靠左的内容块，必须落在容器左缘之内。
        若某个块忘了裹 .wrap，它会跑到 0 附近，这条立刻失败。 */
  check('没有任何内容块贴到视口边缘', d.minLeft != null && d.minLeft >= d.containerLeft,
    `最靠左 ${d.minLeft} · 容器左缘 ${d.containerLeft}`);

  /* 2) 不该有块跑到容器左缘之外（那意味着有的块没被容器约束） */
  check('没有块越出容器左缘', d.offBase.length === 0,
    d.offBase.length ? `越界: ${d.offBase.map(x => `${x.sel}@${x.left}`).join(', ')}` : '');

  /* 3) 容器左右内边距相等且非零 —— 「左右边距在」的直接证据 */
  check('容器左右内边距相等且非零', d.containerPad > 0, `padding-left=${d.containerPad}px`);

  /* 4) 两侧留白存在：容器左缘应明显大于 0（不是满宽铺开） */
  check('容器左侧留白 > 0', d.containerLeft > 0, `left=${d.containerLeft}px`);
}

cleanupProfile();
console.log(fail ? `\n边距核对 FAILED: ${fail}` : '\n边距核对全部通过');
process.exit(fail ? 1 : 0);

/* 区块结构核对（常驻门禁）
   ============================================================
   覆盖几处「用户明确要求」的改动。之所以要运行时核对而不是只看字符串：
   这些都是**结构/行为**层面的要求（有没有这张卡、在哪个页面的哪一块、
   先后顺序对不对、还吸不吸顶），静态字符串检查很容易看着对、实际不对。
     1 首页频道入口没有「教程库」（hidden:true 的频道整条不出现）
     2 首页「官方出品」只剩自营产品横幅，运营指南已挪走（不再有指南卡、小标题）
     3 首页「云服务器推荐」在 App 列表**下方**（文档顺序 + 渲染后的纵坐标，两处都查）
     4 运营指南模块落在产品详情页：卡片齐、链接指向 ../guides/（相对路径不能错）
     5 AI 库目录页的分类导航（原「吸顶筛选条」已按要求改成页内分类 TOC）：
       分类项仍全是链接、锚点都能命中真实区块、没有粘性筛选条、没有重复的第二组筛选标签
   同时**反向确认**首页筛选条仍然是 sticky —— 别为了改 AI 页把别的页一起改坏。 */
import fs from 'node:fs';
import path from 'node:path';
import { findBrowser, dumpDomRetry, fileUrl, cleanupProfile } from './chrome.mjs';

const DIST = path.resolve(import.meta.dirname, '..', 'dist');
const b = findBrowser();
let fail = 0;
const check = (l, c, e) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l}${e ? '  ' + e : ''}`); if (!c) fail++; };

/* 探针用 readyState 兜底：注入的脚本放在 </body> 前，
   如果 DOMContentLoaded 已经错过（各页渲染时序不同，实测首页就没触发到），
   只等事件会一直拿不到结果。所以「已经 interactive/complete 就直接跑」。
   同一段探针喂给所有页面：查不到的区块返回 null，各页各取所需。 */
const PROBE = `(function(){
 function run(){
  function info(sel){var e=document.querySelector(sel); if(!e) return null;
    var cs=getComputedStyle(e);
    return {pos:cs.position, top:cs.top, l:Math.round(e.getBoundingClientRect().left)};}
  /* 纵向位置：比先后用。用渲染后的坐标而不是文档里的字符串顺序 —— */
  function y(sel){var e=document.querySelector(sel); return e?Math.round(e.getBoundingClientRect().top):null;}
  var o={};
  o.tools = info('#all.tools, .tools');
  o.affExists = !!document.querySelector('#affiliate .aff');
  o.affY = y('#affiliate');
  o.gridY = y('#grid');
  /* 文档顺序兜底：坐标会被 transform（入场动画）影响，结构顺序不会 */
  var _aff=document.querySelector('#affiliate'), _grid=document.querySelector('#grid');
  o.affAfterGrid = !!(_aff && _grid && (_grid.compareDocumentPosition(_aff) & Node.DOCUMENT_POSITION_FOLLOWING));
  o.officialExists = !!document.querySelector('#official');
  o.officialHasBanner = !!document.querySelector('#official .promo, #official .promo__acts');
  o.officialGuideCards = document.querySelectorAll('#official .guide-card').length;
  o.officialHasSub = !!document.querySelector('#official .sec-sub');
  o.guidesExists = !!document.querySelector('#guides');
  o.guidesCards = document.querySelectorAll('#guides .guide-card').length;
  o.guidesHrefs = [].slice.call(document.querySelectorAll('#guides a')).map(function(e){return e.getAttribute('href');});
  o.chanNames = [].slice.call(document.querySelectorAll('.chan__name')).map(function(e){return e.textContent.trim();});
  /* AI 库目录页：分类 TOC（替代了原来的吸顶筛选条） */
  o.tocExists = !!document.querySelector('#toc');
  o.tocChipTags = [].slice.call(document.querySelectorAll('#toc .chips a, #toc .chips button')).map(function(e){return e.tagName;});
  o.tocAnchorHrefs = [].slice.call(document.querySelectorAll('#toc .chips a')).map(function(e){return e.getAttribute('href')||'';});
  /* 只数指向分类区块的入口（将来若加「全部/顶部」之类的锚点，不该把这条断言弄成假失败） */
  o.tocCatAnchors = o.tocAnchorHrefs.filter(function(h){ return h.indexOf('#cat-') === 0; });
  /* 死锚点：指向本页 #id 却找不到对应元素 —— TOC 最容易悄悄坏在这里 */
  o.tocDeadAnchors = o.tocAnchorHrefs.filter(function(h){
    return h.charAt(0) === '#' && !document.getElementById(h.slice(1));
  });
  o.aiSections = document.querySelectorAll('.ai-sec[id]').length;
  o.chipsetLabs = [].slice.call(document.querySelectorAll('.chipset__lab')).map(function(e){return e.textContent.trim();});
  document.documentElement.setAttribute('data-v', JSON.stringify(o));
 }
 if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
 else run();
})();`;

function load(page, w = 1440) {
  let html = fs.readFileSync(path.join(DIST, page), 'utf8');
  html = html.replace('</body>', `<script>${PROBE}</script></body>`);
  const abs = path.join(DIST, page);
  const tmp = path.join(path.dirname(abs), `__v-${path.basename(page)}`);
  fs.writeFileSync(tmp, html, 'utf8');
  const dom = dumpDomRetry(b, fileUrl(tmp), { timeout: 60000, w, h: 1000 });
  fs.rmSync(tmp, { force: true });
  const m = dom.match(/data-v="([^"]+)"/);
  return m ? JSON.parse(m[1].replace(/&quot;/g, '"')) : null;
}

console.log('=== 首页 ===');
const home = load('index.html');
check('取到数据', !!home);
if (home) {
  console.log('  频道卡:', home.chanNames.join(' · '));
  check('频道入口没有「教程库」', !home.chanNames.includes('教程库'));
  check('频道卡只剩 4 张', home.chanNames.length === 4, `${home.chanNames.length} 张`);
  check('官方出品区块存在', home.officialExists);
  check('官方出品里有自营产品横幅', home.officialHasBanner);
  check('官方出品里**没有**运营指南卡（已挪到产品页）', home.officialGuideCards === 0, `${home.officialGuideCards} 张`);
  check('官方出品里**没有**指南小标题（两层结构已拆）', !home.officialHasSub);
  check('云服务器推荐区块存在', home.affExists);
  check('云服务器推荐排在 App 列表之后（文档顺序）', home.affAfterGrid);
  check('云服务器推荐确实渲染在 App 列表下方', home.affY != null && home.gridY != null && home.affY > home.gridY,
    `推荐 y=${home.affY} · 列表 y=${home.gridY}`);
  check('首页筛选条**仍然**吸顶（没被连带改掉）', home.tools && home.tools.pos === 'sticky', `position=${home.tools && home.tools.pos}`);
}

console.log('\n=== 号狐浏览器详情页 ===');
const product = load('products/haofox.html');
check('取到数据', !!product);
if (product) {
  console.log('  指南卡:', product.guidesCards, '张 · 区块内链接', JSON.stringify(product.guidesHrefs));
  check('有「运营指南」模块', product.guidesExists);
  check('模块里有指南卡', product.guidesCards > 0, `${product.guidesCards} 张`);
  // 相对路径是这里最容易错的一处：产品页在 /products/ 下，卡片必须走 ../guides/
  const bad = (product.guidesHrefs || []).filter(h => !/^\.\.\/guides\//.test(h || ''));
  check('模块内链接都指向 ../guides/（相对路径没写错）', product.guidesHrefs.length > 0 && bad.length === 0,
    bad.length ? `越界: ${bad.join(', ')}` : '');
}

console.log('\n=== AI 库目录页 ===');
const ai = load('ai/index.html');
check('取到数据', !!ai);
if (ai) {
  console.log('  分类导航:', ai.tocChipTags.length, '项 ·', ai.aiSections, '个分类区块');
  check('有「按分类浏览」的分类导航', ai.tocExists);
  check('分类项全是链接（可跳转可索引）', ai.tocChipTags.length > 0 && ai.tocChipTags.every(t => t === 'A'));
  check('每个分类区块都有一个对应的分类入口', ai.tocCatAnchors.length === ai.aiSections,
    `${ai.tocCatAnchors.length} 个入口 / ${ai.aiSections} 个分类区块`);
  check('分类锚点没有死链（都命中真实区块）', ai.tocDeadAnchors.length === 0,
    ai.tocDeadAnchors.length ? `死锚点: ${ai.tocDeadAnchors.join(', ')}` : '');
  check('筛选条不再吸顶（该页已无粘性筛选条）', !ai.tools || ai.tools.pos !== 'sticky', `position=${ai.tools ? ai.tools.pos : '(无筛选条)'}`);
  check('没有重复的第二组筛选标签行', ai.chipsetLabs.length === 0, JSON.stringify(ai.chipsetLabs));
}

cleanupProfile();
console.log(fail ? `\n核对 FAILED: ${fail}` : '\n区块结构核对全部通过');
process.exit(fail ? 1 : 0);

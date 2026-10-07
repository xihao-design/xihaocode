import fs from 'node:fs';
import path from 'node:path';
import { findBrowser, dumpDomRetry, fileUrl, cleanupProfile } from './chrome.mjs';

const DIST = path.resolve('D:/vitepress/redesign/dist');
const b = findBrowser();

let html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const script = `document.addEventListener('DOMContentLoaded',function(){
  var d=document.getElementById('mobileNav'); if(d) d.setAttribute('data-open','');
  var s=document.getElementById('navScrim'); if(s) s.removeAttribute('hidden');
  document.documentElement.classList.add('side-open');
});
window.addEventListener('load',function(){
  var d=document.getElementById('mobileNav'); if(d) d.setAttribute('data-open','');
  var s=document.getElementById('navScrim'); if(s) s.removeAttribute('hidden');
  document.documentElement.classList.add('side-open');
});`;
const injected = html.replace('</body>', `<script>${script}</script></body>`);
console.log('注入是否发生:', injected !== html);
fs.writeFileSync(path.join(DIST, '__dbg-drawer.html'), injected);

const dom = dumpDomRetry(b, fileUrl(path.join(DIST, '__dbg-drawer.html')), { timeout: 60000 });
console.log('DOM 长度:', dom.length);
const m = dom.match(/<aside class="side"[^>]*>/);
console.log('aside 标签:', m ? m[0] : '(未找到)');
const n = dom.match(/<div class="side__scrim"[^>]*>/);
console.log('遮罩标签:', n ? n[0] : '(未找到)');
const h = dom.match(/<html[^>]*>/);
console.log('html 标签:', h ? h[0] : '(未找到)');
console.log('注入脚本是否在 DOM 里:', /__dbg|mobileNav'\);\s*if\(d\)/.test(dom) || dom.includes("getElementById('mobileNav')"));

fs.rmSync(path.join(DIST, '__dbg-drawer.html'), { force: true });
cleanupProfile();

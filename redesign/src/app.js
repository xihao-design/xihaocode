/* ============================================================
   西浩资源库 · 客户端增强层
   ------------------------------------------------------------
   页面内容由构建期直出（SEO 友好），此脚本只做增量增强：
   主题三态切换、筛选、搜索、复制提取码、外观设置、滚动动效。
   任何一步失败都不影响页面可读性 —— 所有内容默认就是可见的。
   ============================================================ */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var root = document.documentElement;

  /* ---------- 轻提示 ---------- */
  var toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      toastEl.setAttribute('role', 'status');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    requestAnimationFrame(function () { toastEl.setAttribute('data-show', ''); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.removeAttribute('data-show'); }, 2200);
  }

  /* ---------- 复制 ---------- */
  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error('execCommand failed'));
      } catch (e) { reject(e); }
    });
  }

  /* ============================================================
     主题：跟随系统 / 浅色 / 深色，三态循环
     首屏由 <head> 内联脚本预先写好 data-theme，这里只负责切换。
     ============================================================ */
  var THEME_KEY = root.dataset.themeKey || 'xihaoz.theme';
  var ORDER = ['auto', 'light', 'dark'];
  var LABEL = { auto: '跟随系统', light: '浅色', dark: '深色' };
  var PREVIEW = !!window.__THEME_PREVIEW__;
  var mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function readTheme() {
    if (PREVIEW) {
      var pv = root.dataset.themeSource;
      return ORDER.indexOf(pv) >= 0 ? pv : 'auto';
    }
    var v = null;
    try { v = localStorage.getItem(THEME_KEY); } catch (e) { /* 隐私模式 */ }
    // 注意：判断和返回必须用同一个值。早前写成 indexOf(v || 'auto') >= 0 ? v : 'auto'，
    // 结果 v 为 null 时判定通过、却把 null 返回出去，DOM 上就成了 data-theme="null"，
    // 深色主题整块 CSS 匹配不上，主题按钮的图标也全被 display:none 掉。
    return ORDER.indexOf(v) >= 0 ? v : 'auto';
  }

  function themeColorMeta() {
    var m = $('meta[name="theme-color"]');
    if (!m) return;
    var light = root.dataset.themeColorLight || '#F2F3F5';
    var dark = root.dataset.themeColorDark || '#0B0C10';
    m.setAttribute('content', root.dataset.theme === 'dark' ? dark : light);
  }

  function paint(source, animate) {
    // 任何脏值都不许写进 DOM：属性一旦变成 "null"/"undefined"，
    // 主题变量与图标选择器会整体失配，而且是静默的
    if (ORDER.indexOf(source) < 0) source = 'auto';
    var resolved = source === 'auto'
      ? (mql && mql.matches ? 'dark' : 'light')
      : source;
    if (animate) {
      root.setAttribute('data-theme-anim', '');
      setTimeout(function () { root.removeAttribute('data-theme-anim'); }, 260);
    }
    root.dataset.themeSource = source;
    root.dataset.theme = resolved;
    themeColorMeta();
    syncThemeUI(source);
    var btn = $('#themeBtn');
    if (btn) {
      var next = ORDER[(ORDER.indexOf(source) + 1) % ORDER.length];
      btn.setAttribute('aria-label', '当前主题：' + LABEL[source] + '，点击切换到' + LABEL[next]);
      btn.setAttribute('title', '主题：' + LABEL[source] + '（点击切换到' + LABEL[next] + '）');
    }
    $$('#twTheme button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.v === source));
    });
  }

  function syncThemeUI(source) {
    var seg = $('#twTheme');
    if (seg) seg.dataset.value = source;
  }

  function setTheme(source, animate) {
    PREVIEW = false;
    try { localStorage.setItem(THEME_KEY, source); } catch (e) { /* 忽略 */ }
    paint(source, animate);
  }

  function initTheme() {
    paint(readTheme(), false);

    var btn = $('#themeBtn');
    if (btn) {
      btn.addEventListener('click', function () {
        var cur = root.dataset.themeSource || 'auto';
        var next = ORDER[(ORDER.indexOf(cur) + 1) % ORDER.length];
        setTheme(next, true);
        toast('主题：' + LABEL[next]);
      });
    }

    if (mql) {
      var onSys = function () { if ((root.dataset.themeSource || 'auto') === 'auto') paint('auto', false); };
      if (mql.addEventListener) mql.addEventListener('change', onSys);
      else if (mql.addListener) mql.addListener(onSys);
    }
  }

  /* ============================================================
     外观设置（Tweaks）
     ============================================================ */
  var TW_KEY = 'xihaoz.tweaks';
  function loadTweaks() {
    try { return JSON.parse(localStorage.getItem(TW_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveTweaks(t) {
    try { localStorage.setItem(TW_KEY, JSON.stringify(t)); } catch (e) { /* 忽略 */ }
  }
  function applyTweaks(t) {
    document.body.dataset.density = t.density || 'comfy';
    document.body.dataset.neutral = t.neutral || '0';
    $$('#twDensity button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.v === (t.density || 'comfy')));
    });
    $$('#twNeutral button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.v === (t.neutral || '0')));
    });
  }

  function initTweaks() {
    var btn = $('#twBtn'), panel = $('#twPanel');
    if (!btn || !panel) return;
    var t = loadTweaks();
    applyTweaks(t);

    btn.addEventListener('click', function () {
      var open = panel.toggleAttribute('data-open');
      btn.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.tw')) {
        panel.removeAttribute('data-open');
        btn.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panel.hasAttribute('data-open')) {
        panel.removeAttribute('data-open');
        btn.setAttribute('aria-expanded', 'false');
        btn.focus();
      }
    });

    function seg(sel, key) {
      var box = $(sel);
      if (!box) return;
      box.addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (!b) return;
        t[key] = b.dataset.v;
        applyTweaks(t);
        saveTweaks(t);
      });
    }
    seg('#twDensity', 'density');
    seg('#twNeutral', 'neutral');

    var themeSeg = $('#twTheme');
    if (themeSeg) {
      themeSeg.addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (!b) return;
        setTheme(b.dataset.v, true);
      });
    }
  }

  /* ============================================================
     筛选与搜索
     ============================================================ */
  function initFilter() {
    var grid = $('#grid');
    if (!grid) return;
    // 多维筛选（技能库 / AI 库，见 initSkillsFilter）与单维筛选是两套，别在同一个 #grid 上同时跑。
    // 判据是「卡片有没有 data-facets」，不是「页面上有没有筛选项」——
    // 技能库/AI 库的分类页没有筛选条，但卡片带 facets，将来加筛选时才不会两边打架。
    if ($('#grid .card[data-facets]')) return;
    var q = $('#q'), clr = $('#clr'), chips = $('#chips'), empty = $('#empty'), count = $('#shown');
    var cards = $$('.card', grid);
    var state = { cat: 'all', q: '' };

    function apply() {
      var kw = state.q.trim().toLowerCase();
      var shown = 0;
      cards.forEach(function (c) {
        var okCat = state.cat === 'all' || c.dataset.cat === state.cat;
        var hay = c.dataset.hay || '';
        var okKw = !kw || hay.indexOf(kw) !== -1;
        var ok = okCat && okKw;
        c.hidden = !ok;
        if (ok) shown++;
      });
      if (empty) empty.hidden = shown > 0;
      if (count) count.textContent = shown === cards.length
        ? String(cards.length)
        : shown + ' / ' + cards.length;
    }

    if (chips) {
      chips.addEventListener('click', function (e) {
        var b = e.target.closest('[data-cat]');
        if (!b) return;
        e.preventDefault();
        state.cat = b.dataset.cat;
        $$('[data-cat]', chips).forEach(function (x) {
          x.setAttribute('aria-pressed', String(x.dataset.cat === state.cat));
        });
        apply();
      });
    }

    function syncClear() { if (clr) clr.toggleAttribute('data-show', !!(q && q.value)); }

    if (q) {
      q.addEventListener('input', function () {
        state.q = q.value;
        syncClear();
        apply();
      });
      window.addEventListener('pageshow', function () {
        state.q = q.value || '';
        syncClear();
        apply();
      });
    }
    if (clr) {
      clr.addEventListener('click', function () {
        q.value = ''; state.q = '';
        clr.removeAttribute('data-show');
        q.focus(); apply();
      });
    }
    var reset = $('#reset');
    if (reset) {
      reset.addEventListener('click', function () {
        state.cat = 'all'; state.q = '';
        if (q) q.value = '';
        if (clr) clr.removeAttribute('data-show');
        if (chips) $$('[data-cat]', chips).forEach(function (x) {
          x.setAttribute('aria-pressed', String(x.dataset.cat === 'all'));
        });
        apply();
      });
    }

    // ?q= 与 ?cat= 深链（搜索结果可分享）
    var sp = new URLSearchParams(location.search);
    if (sp.get('cat') && chips) {
      state.cat = sp.get('cat');
      $$('[data-cat]', chips).forEach(function (x) {
        x.setAttribute('aria-pressed', String(x.dataset.cat === state.cat));
      });
    }
    if (sp.get('q') && q) {
      q.value = sp.get('q');
      state.q = q.value;
      syncClear();
    }
    apply();
  }

  /* ---------- Ctrl/⌘+K 或 / 聚焦搜索 ---------- */
  function initSearchKeys() {
    var q = $('#q');
    if (!q) return;
    document.addEventListener('keydown', function (e) {
      var typing = /^(input|textarea|select)$/i.test((e.target.tagName || ''));
      var isK = (e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey);
      var isSlash = e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey;
      if (!isK && !isSlash) return;
      if (isK && typing) return;
      e.preventDefault();
      var tools = $('.tools');
      if (tools && tools.getBoundingClientRect().top < 0) {
        tools.scrollIntoView({ block: 'start' });
      }
      q.focus();
      q.select();
    });
  }

  /* ---------- 技能库 / AI 库筛选：多维度 + 搜索 ----------
     卡片带 data-facets="repo=…;host=…;mode=…"（AI 库是 cat/oss/vpn/free），
     筛选项带 data-facet="key=value"。
     同一维度内是多选（或），不同维度之间是且 —— 这是筛选器的常规语义：
     「Anthropic 官方 或 addyosmani」里再挑「有网盘包」，不能变成「同时属于两个来源」。 */
  function initSkillsFilter() {
    var grid = $('#grid'), chips = $('#chips');
    if (!grid || !chips) return;
    var facetChips = $$('[data-facet]', chips);
    if (!facetChips.length) return;
    // 这个筛选器只接管带 facets 的卡片：页面上若混着普通卡片（比如后续加了推荐位），
    // 那些卡片不该被 facet 过滤掉，它们的显隐交给自己的规则。
    var cards = $$('.card[data-facets]', grid);
    if (!cards.length) return;

    var q = $('#q'), clr = $('#clr'), empty = $('#empty'), count = $('#shown');
    var state = {};   // key -> Set(values)，空集合表示该维度不筛

    cards.forEach(function (c) {
      var f = {};
      (c.dataset.facets || '').split(';').forEach(function (kv) {
        var i = kv.indexOf('=');
        if (i <= 0) return;
        var k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
        // 累积而不是覆盖：同一个 key 可以出现多次（电脑软件页一款软件可能同时支持
        // Windows 与 macOS，见 live/app-delta.js）。单值卡片行为与从前一致。
        (f[k] = f[k] || []).push(v);
      });
      c._facets = f;
    });

    var split = function (raw) {
      var i = raw.indexOf('=');
      return { key: raw.slice(0, i), value: raw.slice(i + 1) };
    };

    function apply() {
      var kw = ((q && q.value) || '').trim().toLowerCase();
      var shown = 0;
      cards.forEach(function (c) {
        var ok = true;
        for (var k in state) {
          if (!state[k].size) continue;
          var vals = c._facets[k];
          // 同一维度内取「或」：已选值与卡片值有交集即命中
          if (!vals || !vals.some(function (v) { return state[k].has(v); })) { ok = false; break; }
        }
        if (ok && kw) ok = (c.dataset.hay || '').indexOf(kw) !== -1;
        c.hidden = !ok;
        if (ok) shown++;
      });
      if (empty) empty.hidden = shown > 0;
      if (count) count.textContent = shown === cards.length ? String(cards.length) : shown + ' / ' + cards.length;
      if (clr) clr.toggleAttribute('data-show', !!(q && q.value));
      syncUrl();
    }

    function syncChips() {
      facetChips.forEach(function (b) {
        var f = split(b.dataset.facet);
        var on = f.value === '*'
          ? !(state[f.key] && state[f.key].size)
          : !!(state[f.key] && state[f.key].has(f.value));
        b.setAttribute('aria-pressed', String(on));
      });
    }

    function syncUrl() {
      // 筛选结果可分享：?repo=&host=&mode=&q=
      if (!window.history || !history.replaceState) return;
      var sp = new URLSearchParams();
      for (var k in state) if (state[k] && state[k].size) sp.set(k, [...state[k]].join(','));
      if (q && q.value.trim()) sp.set('q', q.value.trim());
      var qs = sp.toString();
      history.replaceState(null, '', qs ? '?' + qs : location.pathname);
    }

    chips.addEventListener('click', function (e) {
      var b = e.target.closest('[data-facet]');
      if (!b) return;
      var f = split(b.dataset.facet);
      if (f.value === '*') state[f.key] = new Set();
      else {
        state[f.key] = state[f.key] || new Set();
        if (state[f.key].has(f.value)) state[f.key].delete(f.value);
        else state[f.key].add(f.value);
      }
      syncChips();
      apply();
    });

    if (q) q.addEventListener('input', apply);

    if (clr) {
      clr.addEventListener('click', function () {
        q.value = ''; q.focus(); apply();
      });
    }

    var reset = $('#reset');
    if (reset) {
      reset.addEventListener('click', function () {
        state = {};
        if (q) q.value = '';
        syncChips(); apply();
      });
    }

    // 深链：技能库用 repo/host/mode，AI 库用 cat/oss/vpn/free —— 一起认，
    // 各自多余的参数不会命中任何卡片，代价可以忽略
    var sp = new URLSearchParams(location.search);
    ['repo', 'host', 'mode', 'cat', 'oss', 'vpn', 'free', 'plat'].forEach(function (k) {
      var v = sp.get(k);
      if (v) state[k] = new Set(v.split(',').filter(Boolean));
    });
    if (sp.get('q') && q) q.value = sp.get('q');

    syncChips();
    apply();
  }

  /* ---------- 提取码复制 / 打开网盘 ---------- */
  function initDownload() {
    $$('[data-copy]').forEach(function (b) {
      b.addEventListener('click', function () {
        var val = b.getAttribute('data-copy');
        copy(val).then(function () {
          toast('提取码 ' + val + ' 已复制');
        }).catch(function () {
          toast('复制失败，请手动记下：' + val);
        });
      });
    });

    var get = $('#dGet');
    if (get) {
      // 这里**不再自己打开链接**。
      // #dGet 是一个真 <a href="…?pwd=xxxx">：百度认这个参数会自动填入提取码并直接进文件列表
      // （实测：不带 pwd 的地址渲染出「请输入提取码」，带 pwd 的直接出文件列表）。
      // 之前是 copy().then(→setTimeout→window.open)，异步间隙之后调 window.open 会被
      // 移动端弹窗拦截 —— 表现就是「手机上点了没反应」。
      // 现在浏览器自己处理跳转，JS 只做锦上添花：顺手复制提取码（JS 关了也照样能打开）。
      get.addEventListener('click', function () {
        var pwd = get.getAttribute('data-pwd');
        if (!pwd) return;                      // 没提取码就是个普通链接
        copy(pwd).then(function () {
          toast('提取码 ' + pwd + ' 已复制，网盘页面会自动填入');
        }).catch(function () {
          toast('提取码：' + pwd + '（网盘页面会自动填入，无需手输）');
        });
      });
    }
  }

  /* ---------- 滚动：顶栏收紧、返回顶部、进入动画 ---------- */
  function initScroll() {
    var hdr = $('.hdr'), top = $('#toTop');
    var ticking = false;

    function onScroll() {
      var y = window.scrollY || document.documentElement.scrollTop;
      if (hdr) {
        if (y > 8) hdr.setAttribute('data-stuck', '');
        else hdr.removeAttribute('data-stuck');
      }
      if (top) {
        if (y > 620) top.setAttribute('data-show', '');
        else top.removeAttribute('data-show');
      }
      ticking = false;
    }
    window.addEventListener('scroll', function () {
      if (!ticking) { ticking = true; requestAnimationFrame(onScroll); }
    }, { passive: true });
    onScroll();

    if (top) {
      top.addEventListener('click', function () {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }

    // 进入动画：先给 html 打标记，CSS 才隐藏元素 —— JS 挂了内容依然可见
    var items = $$('[data-reveal]');
    if (!items.length) return;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !('IntersectionObserver' in window)) return;
    root.classList.add('js-reveal');
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add('is-in');
        io.unobserve(en.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.04 });
    items.forEach(function (el) { io.observe(el); });

    // 兜底：万一 IO 因为任何原因没有回调（被遮挡、极端布局），
    // 3 秒后把剩下的全部显示出来 —— 宁可少一段动画，不能少内容。
    setTimeout(function () {
      items.forEach(function (el) { el.classList.add('is-in'); });
    }, 3000);
  }

  /* ============================================================
     导航：顶栏巨型分类菜单（桌面）+ 抽屉（窄屏）
     ------------------------------------------------------------
     两件事以前都没有实现，这次一并补上：
       1) 抽屉开关。按钮和遮罩在 HTML 里一直存在，但**没有任何 JS 绑定它** ——
          表现就是「点了没反应」，正是「不能点击的按钮」。
       2) 巨型菜单。桌面端靠按钮展开（不是纯 hover）：hover 展开在触屏和
          键盘下都不好用，而按钮可以聚焦、可以 Esc 关闭、可以点外部关闭。
     ============================================================ */
  function initNav() {
    var root = document.documentElement;
    var drawer = $('#mobileNav');
    var btn = $('#navBtn'), close = $('#navClose'), scrim = $('#navScrim');

    /** 开关抽屉。用属性存在与否表达状态（不是 data-open="true"），
        因为 CSS 用 [data-open] 选择，属性在就行。 */
    function setOpen(open) {
      if (drawer) { if (open) drawer.setAttribute('data-open', ''); else drawer.removeAttribute('data-open'); }
      if (scrim) { if (open) scrim.removeAttribute('hidden'); else scrim.setAttribute('hidden', ''); }
      root.classList.toggle('side-open', open);
      if (btn) btn.setAttribute('aria-expanded', String(open));
    }
    if (btn && drawer) btn.addEventListener('click', function () {
      var willOpen = !drawer.hasAttribute('data-open');
      setOpen(willOpen);
      if (willOpen && close) close.focus();
    });
    if (close) close.addEventListener('click', function () { setOpen(false); if (btn) btn.focus(); });
    if (scrim) scrim.addEventListener('click', function () { setOpen(false); });
    // 窗口拉宽回桌面尺寸时把抽屉关掉，否则滚动会被 .side-open 锁住
    if (window.matchMedia) {
      var wide = window.matchMedia('(min-width:1080px)');
      var onWide = function () { if (wide.matches) setOpen(false); };
      if (wide.addEventListener) wide.addEventListener('change', onWide);
      else if (wide.addListener) wide.addListener(onWide);
    }
    setOpen(false);

    /* ---- 巨型分类菜单 ---- */
    var groups = $$('.nav__grp');
    if (!groups.length) return;
    function closeAll(except) {
      groups.forEach(function (g) {
        if (g === except) return;
        var b = $('.nav__exp', g);
        var p = b && document.getElementById(b.getAttribute('aria-controls'));
        if (b) b.setAttribute('aria-expanded', 'false');
        if (p) p.setAttribute('hidden', '');
      });
    }
    groups.forEach(function (g) {
      var b = $('.nav__exp', g);
      if (!b) return;
      var panel = document.getElementById(b.getAttribute('aria-controls'));
      if (!panel) return;
      b.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var willOpen = b.getAttribute('aria-expanded') !== 'true';
        closeAll(g);
        b.setAttribute('aria-expanded', String(willOpen));
        if (willOpen) panel.removeAttribute('hidden'); else panel.setAttribute('hidden', '');
      });
      /* 这里**刻意不绑 mouseleave**。
         巨型菜单面板是整个顶栏的兄弟元素（不是 .nav__grp 的子元素），
         所以鼠标从「AI 库」移向面板时必然先离开 .nav__grp ——
         绑了 mouseleave 就会在这一点上把菜单关掉，用户根本移不到子类上
         （实测：点了下拉，鼠标一动菜单就消失，子分类点不到）。
         关闭只认三种明确动作：再点一次按钮、点菜单外、按 Esc。 */
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest || !e.target.closest('.hdr')) closeAll(null);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeAll(null);
    });
  }

  /* ---------- 启动 ---------- */
  function boot() {
    initTheme();
    initTweaks();
    initNav();
    initFilter();
    initSkillsFilter();
    initSearchKeys();
    initDownload();
    initScroll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

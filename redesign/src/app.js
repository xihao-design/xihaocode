/* ============================================================
   客户端增强层
   页面内容由构建期直出（SEO 友好），此脚本只做增量增强：
   筛选、搜索、复制提取码、外观 Tweaks。
   任何一步失败都不影响页面可读性。
   ============================================================ */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

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

  /* ---------- 外观 Tweaks（持久化） ---------- */
  var TW_KEY = 'xihaouc.tweaks';
  function applyTweaks(t) {
    document.body.dataset.density = t.density || 'comfy';
    document.body.dataset.neutral = t.neutral || '0';
    $$('#twDensity button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.v === (t.density || 'comfy'))); });
    $$('#twNeutral button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.v === (t.neutral || '0'))); });
  }
  function loadTweaks() {
    try { return JSON.parse(localStorage.getItem(TW_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveTweaks(t) {
    try { localStorage.setItem(TW_KEY, JSON.stringify(t)); } catch (e) { /* 隐私模式忽略 */ }
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
  }

  /* ---------- 首页筛选与搜索 ---------- */
  function initFilter() {
    var grid = $('#grid');
    if (!grid) return;
    var q = $('#q'), clr = $('#clr'), chips = $('#chips'), empty = $('#empty');
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

    if (q) {
      q.addEventListener('input', function () {
        state.q = q.value;
        if (clr) clr.toggleAttribute('data-show', !!q.value);
        apply();
      });
      // 浏览器前进/后退或页面缓存恢复时同步
      window.addEventListener('pageshow', function () {
        state.q = q.value || '';
        if (clr) clr.toggleAttribute('data-show', !!q.value);
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

    // 支持 ?q= 与 ?cat= 深链（搜索结果可分享）
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
      if (clr) clr.setAttribute('data-show', '');
    }
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
      get.addEventListener('click', function () {
        var pwd = get.getAttribute('data-pwd');
        var url = get.getAttribute('data-url');
        var done = function () { window.open(url, '_blank', 'noopener'); };
        if (!pwd) { done(); return; }
        copy(pwd).then(function () {
          toast('提取码 ' + pwd + ' 已复制，正在打开网盘…');
          setTimeout(done, 260);
        }).catch(function () {
          toast('提取码：' + pwd);
          done();
        });
      });
    }
  }

  /* ---------- 启动 ---------- */
  function boot() {
    initTweaks();
    initFilter();
    initDownload();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

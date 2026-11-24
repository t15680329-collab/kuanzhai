/* 中转下载页逻辑。外链脚本，符合站点 CSP（script-src 'self'）。
   打开页面即自动触发主线路 APK 下载；接口不通时用内置兜底。
   备用线路只在「下载没反应」时以小字展示，避免玩家看到一堆地址犯晕。 */
(function () {
  'use strict';
  var ua = navigator.userAgent.toLowerCase();
  var isWeixin = /micromessenger/.test(ua);
  var isIOS = /iphone|ipad|ipod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  var stateTxt = document.getElementById('stateTxt');
  var stateSub = document.getElementById('stateSub');
  var spin = document.getElementById('spin');
  var manualBtn = document.getElementById('manualBtn');
  var alt = document.getElementById('alt');
  var altLinks = document.getElementById('altLinks');

  // 微信内置浏览器：只提示，不自动下载
  if (isWeixin) {
    document.getElementById('wxtip').classList.add('on');
    spin.style.display = 'none';
    stateTxt.textContent = '微信内无法直接下载';
    stateSub.textContent = '请按上方提示用浏览器打开本页';
    return;
  }

  // iOS：没有安装包，指引加主屏
  if (isIOS) {
    document.getElementById('wxtip').style.display = 'none';
    spin.style.display = 'none';
    stateTxt.textContent = 'iPhone 请添加到主屏幕';
    stateSub.textContent = '用 Safari 打开游戏地址 → 分享 → 添加到主屏幕';
    document.getElementById('apkList');
    var iosBox = document.getElementById('iosBox');
    if (iosBox) iosBox.style.display = 'none'; // 说明已在主卡片里，不再重复
    return;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var sources = null;   // APK 下载源（第一个为主线路）
  var webUrls = [];

  function triggerDownload(url) {
    // 跳转到 attachment 链接：浏览器留在本页并开始下载
    try { window.location.replace(url); } catch (e) { window.location.href = url; }
  }

  function showReady() {
    spin.style.display = 'none';
    stateTxt.textContent = '下载已开始';
    stateSub.textContent = '没弹出来？点下方按钮重新下载';
    manualBtn.style.display = 'inline-block';
    manualBtn.href = sources && sources.length ? sources[0].url : '#';
    if (sources && sources.length > 1) {
      alt.classList.add('on');
      altLinks.innerHTML = sources.slice(1).map(function (x) {
        return '<a href="' + esc(x.url) + '">' + esc(x.label || '备用线路') + '</a>';
      }).join(' · ');
    }
  }

  function showFail() {
    spin.style.display = 'none';
    stateTxt.textContent = '没有自动开始？';
    stateSub.textContent = '点击下方按钮重新下载';
    manualBtn.style.display = 'inline-block';
    manualBtn.href = sources && sources.length ? sources[0].url : '#';
    if (sources && sources.length > 1) {
      alt.classList.add('on');
      altLinks.innerHTML = sources.slice(1).map(function (x) {
        return '<a href="' + esc(x.url) + '">' + esc(x.label || '备用线路') + '</a>';
      }).join(' · ');
    }
  }

  function renderWeb(list) {
    if (!list || !list.length) return;
    webUrls = list;
    var el = document.getElementById('webUrl');
    if (el) el.innerHTML = '<a href="' + esc(list[0].url) + '">' + esc(list[0].url) + '</a>';
  }

  // 兜底：接口万一不通，仍给自建线路 + GitHub 应急源
  var fallback = {
    apk: [
      { url: 'https://kuanzhai36.it.com/kuanzhai.apk', label: '主线路' },
      { url: 'https://43.129.229.47.nip.io/kuanzhai.apk', label: '备用线路' },
      { url: 'https://github.com/t15680329-collab/kuanzhai/releases/download/v0.22.95/kuanzhai-v0.22.95.apk', label: '应急线路' }
    ],
    web: [
      { url: 'https://kuanzhai36.it.com/', label: '主线路' },
      { url: 'https://43.129.229.47.nip.io/', label: '备用线路' }
    ]
  };

  function start() {
    if (!sources || !sources.length) { showFail(); return; }
    // 延迟一帧触发，避免部分浏览器拦截无手势跳转
    setTimeout(function () { triggerDownload(sources[0].url); }, 150);
    // 3 秒后仍停留本页 → 显示「下载已开始」+ 备用线路小字
    setTimeout(function () {
      if (document.visibilityState === 'visible') showReady();
    }, 3000);
  }

  fetch('/api/entries', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      sources = (j && j.apk && j.apk.length) ? j.apk : fallback.apk;
      renderWeb((j && j.web && j.web.length) ? j.web : fallback.web);
      start();
    })
    .catch(function () {
      sources = fallback.apk;
      renderWeb(fallback.web);
      start();
    });
})();

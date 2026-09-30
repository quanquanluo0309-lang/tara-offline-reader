(async function () {
  'use strict';
  const media = window.PWA_MEDIA;
  const status = document.getElementById('offline-status');
  const action = document.getElementById('offline-download');
  const progress = document.getElementById('offline-progress');
  const prefix = 'reader-' + window.PWA_APP_ID + '-' + encodeURIComponent(new URL('./', document.baseURI).pathname) + '-';
  const cacheName = prefix + 'audio-' + media.sha256;
  const url = path => new URL(path, document.baseURI).href;
  const digest = async data => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), x => x.toString(16).padStart(2, '0')).join('');
  let working = false, aborter, ready = false, deleting = false, registration, checking = false, updateAvailable = false, lastCheck = 0;
  const remove = document.getElementById('offline-delete'), update = document.getElementById('app-update');
  const updateStatus = document.getElementById('app-update-status');
  const build = document.querySelector('meta[name=app-build]').content;
  document.getElementById('app-version').textContent = '当前页面版本 ' + build;
  function syncActions() { remove.disabled = !ready || working || deleting; update.disabled = !ready || working || deleting || checking; }
  const standalone = () => navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const environment = standalone() ? '主屏幕应用' : '当前浏览器';
  const help = document.getElementById('install-help');
  help.querySelector('p').textContent = standalone()
    ? '主屏幕应用的下载状态与 Safari 分开检查。请在此点「下载本课」，显示离线可用后再断网。下载时保持应用打开。'
    : 'iPhone：Safari 分享 → 添加到主屏幕 → 从桌面图标打开 → 下载本课。浏览器已下载不代表主屏幕应用也已保存；两处分别显示、删除和更新各自的下载。';
  async function inventory() {
    const cache = await caches.open(cacheName);
    const done = [];
    for (const part of media.parts) {
      const response = await cache.match(url(part.path));
      if (response && response.headers.get('X-Verified-SHA256') === part.sha256 && Number(response.headers.get('Content-Length')) === part.size) done.push(part.path);
    }
    return done;
  }
  async function refresh() {
    if (!ready || working || deleting) return;
    const done = await inventory();
    const full = done.length === media.parts.length;
    action.disabled = full;
    action.textContent = full ? '已下载' : done.length ? '继续下载' : '下载本课';
    status.textContent = environment + ' · ' + (full ? '离线可用 · 音频和全文已保存' : navigator.onLine ? `音频 ${(media.size / 1048576).toFixed(1)} MiB · ${done.length ? '已保存 ' + done.length + '/' + media.parts.length + ' 部分' : '尚未下载，请在这里下载'}` : '音频未完整下载，请联网后在这里下载');
    help.open = !full && standalone();
    status.dataset.state = full ? 'ready' : 'partial';
    syncActions();
  }
  action.addEventListener('click', async () => {
    if (working) { aborter.abort(); return; }
    if (deleting) return;
    working = true; syncActions(); aborter = new AbortController(); action.textContent = '暂停下载'; progress.hidden = false;
    let wakeLock;
    try {
      if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
      try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
      const cache = await caches.open(cacheName), done = new Set(await inventory());
      let saved = media.parts.filter(p => done.has(p.path)).reduce((n, p) => n + p.size, 0);
      if (navigator.storage && navigator.storage.estimate) {
        const estimate = await navigator.storage.estimate();
        if (estimate.quota && estimate.quota - estimate.usage < (media.size - saved) * 1.15) throw new Error('手机空间不足，请释放空间后再试');
      }
      for (const part of media.parts) {
        if (done.has(part.path)) continue;
        if (aborter.signal.aborted) throw new DOMException('下载已暂停', 'AbortError');
        const response = await fetch(url(part.path), { signal: aborter.signal, cache: 'no-store', redirect: 'error' });
        if (!response.ok) throw new Error('下载失败，请联网后重试');
        const reader = response.body.getReader(), data = new Uint8Array(part.size);
        let offset = 0;
        while (true) {
          const result = await reader.read(); if (result.done) break;
          if (offset + result.value.length > part.size) { await reader.cancel(); throw new Error('音频下载校验失败'); }
          data.set(result.value, offset); offset += result.value.length;
          progress.value = (saved + offset) / media.size * 100;
          status.textContent = `下载中 ${Math.floor(progress.value)}% · ${((saved + offset) / 1048576).toFixed(1)} / ${(media.size / 1048576).toFixed(1)} MiB`;
        }
        if (offset !== part.size || await digest(data) !== part.sha256) throw new Error('音频下载不完整，点击继续下载');
        await cache.put(url(part.path), new Response(data, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(part.size), 'X-Verified-SHA256': part.sha256 } }));
        saved += part.size;
      }
      working = false; await refresh();
      // An incomplete offline media request may have put the player into an error state.
      const player = document.getElementById('audio');
      if (player.error) { const position = player.currentTime; player.load(); player.addEventListener('loadedmetadata', () => { player.currentTime = position; }, { once: true }); }
    } catch (error) {
      working = false;
      status.textContent = error.name === 'AbortError' ? '下载已暂停 · 再点可继续' : error.name === 'QuotaExceededError' ? '手机空间不足 · 已下载部分保留' : error.message;
      status.dataset.state = 'error'; action.textContent = '继续下载';
    } finally {
      working = false; progress.hidden = true; syncActions();
      if (wakeLock) await wakeLock.release().catch(() => {});
    }
  });
  remove.addEventListener('click', async () => {
    if (!ready || working || deleting) return;
    if (!confirm('删除本课下载的离线音频？字幕、阅读设置和已有标记会保留。删除后需重新下载才能离线播放。')) return;
    deleting = true; syncActions(); action.disabled = true;
    const player = document.getElementById('audio'), position = player.currentTime;
    player.pause(); player.removeAttribute('src'); player.load();
    try {
      for (const name of await caches.keys()) if (name.startsWith(prefix + 'audio-')) await caches.delete(name);
      deleting = false; await refresh();
      status.textContent = environment + '的音频下载已删除 · 字幕与设置已保留';
    } catch (_) { status.textContent = '删除失败，请重试'; }
    finally {
      deleting = false; syncActions(); action.disabled = false;
      player.preload = 'none';
      player.addEventListener('loadedmetadata', () => { if (Number.isFinite(position)) player.currentTime = Math.min(position, player.duration || position); }, { once: true });
      player.src = './media.mp3';
    }
  });
  function workerVersion(worker) {
    return new Promise(resolve => {
      if (!worker) { resolve(null); return; }
      const channel = new MessageChannel();
      const timer = setTimeout(() => { channel.port1.close(); resolve(null); }, 2500);
      channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data); };
      try { worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]); } catch (_) { clearTimeout(timer); channel.port1.close(); resolve(null); }
    });
  }
  async function showInstalledUpdate() {
    const version = await workerVersion(navigator.serviceWorker.controller);
    if (!version || version.version === build) return false;
    updateAvailable = true; update.textContent = '应用更新';
    updateStatus.textContent = version.audio === media.sha256 ? '新版已就绪 · 应用后保留已下载音频与设置' : '新版已就绪 · 音频有变化，应用后需重新下载';
    return true;
  }
  function waitForWorker(worker) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new Error('更新尚未完成，请稍后重试')), 30000);
      function done(error) { clearTimeout(timer); worker.removeEventListener('statechange', changed); error ? reject(error) : resolve(); }
      function changed() { if (worker.state === 'activated') done(); else if (worker.state === 'redundant') done(new Error('新版安装校验失败，请稍后重试')); }
      worker.addEventListener('statechange', changed); changed();
    });
  }
  async function publishedVersion() {
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 12000);
    try {
      // This manifest deliberately bypasses the shell cache. A working connection
      // and the published version, not navigator.onLine, prove "latest".
      const response = await fetch(url('release.json') + '?check=' + Date.now(), { cache: 'no-store', redirect: 'error', signal: abort.signal });
      if ([401, 403].includes(response.status)) throw new Error('登录已失效，请在浏览器打开网站并重新登录后重试');
      if (!response.ok) throw new Error('无法获取线上版本（' + response.status + '），请稍后重试');
      if (!(response.headers.get('Content-Type') || '').includes('application/json')) throw new Error('未取得版本信息，请在浏览器确认网站可正常打开后重试');
      const release = await response.json();
      if (!/^[a-f0-9]{12}$/.test(release.appVersion) || !/^[a-f0-9]{16}$/.test(release.workerVersion)) throw new Error('线上版本信息不完整，请稍后重试');
      return release;
    } finally { clearTimeout(timeout); }
  }
  async function checkUpdate(manual = false) {
    if (!registration || checking || working || deleting) return;
    if (!manual && Date.now() - lastCheck < 60000) return;
    lastCheck = Date.now(); checking = true; syncActions();
    if (manual) updateStatus.textContent = '正在检查更新…';
    let installing;
    const track = () => { installing = registration.installing || installing; };
    try {
      if (await showInstalledUpdate()) return;
      if (!navigator.onLine) { updateStatus.textContent = '当前离线 · 联网后可检查更新'; return; }
      const release = await publishedVersion();
      // Capture updatefound before update(): a failed worker can disappear from
      // registration.installing before the update() promise resolves.
      registration.addEventListener('updatefound', track); track();
      await registration.update();
      const worker = registration.installing || registration.waiting || installing;
      if (worker) await waitForWorker(worker);
      let installed = await workerVersion(navigator.serviceWorker.controller);
      if (worker && installed?.version !== release.appVersion) {
        // activated precedes clients.claim/controllerchange on some browsers.
        const deadline = Date.now() + 5000;
        while (installed?.version !== release.appVersion && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 200));
          installed = await workerVersion(navigator.serviceWorker.controller);
        }
      }
      if (installed?.version !== release.appVersion) throw new Error('发现新版，但尚未安装成功，请稍后再次检查更新');
      if (!await showInstalledUpdate()) updateStatus.textContent = '当前已是最新版本 · 已与网站核对';
    } catch (error) {
      const detail = error.name === 'TypeError' || error.name === 'AbortError' ? '无法连接更新服务，请确认网站可访问后重试' : error.message;
      updateStatus.textContent = detail + ' · 现有离线内容仍可使用';
    } finally { registration.removeEventListener('updatefound', track); checking = false; syncActions(); }
  }
  update.addEventListener('click', () => {
    if (!updateAvailable) { checkUpdate(true); return; }
    const player = document.getElementById('audio');
    try { sessionStorage.setItem(prefix + 'update-position', String(player.currentTime)); } catch (_) {}
    player.pause(); location.reload();
  });
  navigator.serviceWorker?.addEventListener('controllerchange', () => { if (ready) showInstalledUpdate().catch(() => {}); });
  window.addEventListener('online', () => { refresh().catch(() => {}); checkUpdate(); });
  window.addEventListener('offline', () => refresh().catch(() => {}));
  window.addEventListener('pageshow', () => refresh().catch(() => {}));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh().catch(() => {}); checkUpdate(); } });
  try {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) throw new Error('请用 Safari 打开正式 HTTPS 链接');
    registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('离线初始化未完成，请联网后重新打开')), 30000))
    ]);
    if (!navigator.serviceWorker.controller) await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('离线初始化未完成，请重新打开')), 15000);
      navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(timeout); resolve(); }, { once: true });
    });
    ready = true;
    const audio = document.getElementById('audio');
    let resume = null; try { const saved = sessionStorage.getItem(prefix + 'update-position'); if (saved !== null) resume = Number(saved); sessionStorage.removeItem(prefix + 'update-position'); } catch (_) {}
    if (Number.isFinite(resume) && resume > 0) audio.addEventListener('loadedmetadata', () => { audio.currentTime = Math.min(resume, audio.duration || resume); }, { once: true });
    audio.src = './media.mp3'; audio.load();
    await refresh(); checkUpdate();
  } catch (error) { status.textContent = error.message; status.dataset.state = 'error'; action.disabled = true; }
})();

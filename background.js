const DB_NAME = 'zoopla_crawler_db';
const STORE = 'properties';

const PREFIX_CFG = 'cfg_';
const PREFIX_CRAWL = 'crawl_';
const PREFIX_COLLECT = 'collect_';
const PREFIX_CPROG = 'cprog_';

function k(prefix, tabId) { return prefix + String(tabId); }

async function getTab(prefix, tabId) {
  const key = k(prefix, tabId);
  const o = await chrome.storage.local.get(key);
  return o[key] || null;
}

async function setTab(prefix, tabId, data) {
  await chrome.storage.local.set({ [k(prefix, tabId)]: data });
}

async function removeTab(prefix, tabId) {
  await chrome.storage.local.remove(k(prefix, tabId));
}

async function getAllWithPrefix(prefix) {
  const all = await chrome.storage.local.get(null);
  const result = {};
  for (const key of Object.keys(all)) {
    if (key.startsWith(prefix)) {
      const id = key.slice(prefix.length);
      result[id] = all[key];
    }
  }
  return result;
}

async function removeAllWithPrefix(prefix) {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith(prefix));
  if (keys.length > 0) await chrome.storage.local.remove(keys);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onerror = () => reject(r.error);
    r.onsuccess = () => resolve(r.result);
    r.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'url' });
        store.createIndex('created', 'created_at', { unique: false });
      }
    };
  });
}

async function clearAllProperties() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function getAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function add(record) {
  const db = await openDb();
  const row = { ...record, created_at: new Date().toISOString() };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).put(row);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function count() {
  const arr = await getAll();
  return arr.length;
}

async function maybeAutoPushAfterSave(tabId) {
  if (tabId == null) return;
  const cfg = await getTab(PREFIX_CFG, tabId);
  if (!cfg || !cfg.locked) return;
  const every = (cfg.autoPushEvery != null) ? Math.max(1, cfg.autoPushEvery) : 0;
  if (every <= 0) return;
  const { backendUrl } = await chrome.storage.sync.get('backendUrl');
  if (!backendUrl || !backendUrl.trim()) return;
  const cnt = await count();
  if (cnt < every || cnt % every !== 0) return;
  const rows = await getAll();
  const url = backendUrl.replace(/\/$/, '') + '/api/properties';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: rows })
    });
    if (res.ok) {
      await clearAllProperties();
    }
  } catch (e) {}
}

async function pushRemainderToBackend(tabId) {
  const cnt = await count();
  if (cnt === 0) {
    await removeTab(PREFIX_CRAWL, tabId);
    return;
  }
  const cfg = await getTab(PREFIX_CFG, tabId);
  if (!cfg || !cfg.locked) {
    await removeTab(PREFIX_CRAWL, tabId);
    return;
  }
  const { backendUrl } = await chrome.storage.sync.get('backendUrl');
  if (!backendUrl || !backendUrl.trim()) {
    await removeTab(PREFIX_CRAWL, tabId);
    return;
  }
  const rows = await getAll();
  const url = backendUrl.replace(/\/$/, '') + '/api/properties';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: rows })
    });
    if (res.ok) {
      await clearAllProperties();
      await removeTab(PREFIX_CRAWL, tabId);
    }
  } catch (e) {}
}

async function fetchExistingUrlsFromBackend(urls) {
  const { backendUrl } = await chrome.storage.sync.get('backendUrl');
  if (!backendUrl || !backendUrl.trim()) return new Set();
  const base = backendUrl.replace(/\/$/, '') + '/api/properties/check-urls';
  const existing = new Set();
  const chunkSize = 500;
  for (let i = 0; i < urls.length; i += chunkSize) {
    const chunk = urls.slice(i, i + chunkSize);
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: chunk })
      });
      if (res.ok) {
        const data = await res.json();
        (data.existing || []).forEach((u) => existing.add(u));
      }
    } catch (e) {}
  }
  return existing;
}

function isSearchPageUrl(url) {
  return url && /zoopla\.co\.uk\/for-sale\/property\/[^/]+\/?/.test(url) && !/\/for-sale\/details\/\d+/.test(url);
}

function getLocationFromBaseUrl(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') return null;
  const m = baseUrl.match(/\/property\/([^/?]+)/);
  return m ? m[1].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : null;
}

async function runMultiPageCollectStep(tabId, state) {
  const { baseUrl, currentPage, maxRecords, collectedUrls } = state;
  if (collectedUrls.length >= maxRecords) {
    const queue = collectedUrls.slice(0, maxRecords);
    const crawlLocation = getLocationFromBaseUrl(baseUrl);
    await setTab(PREFIX_CPROG, tabId, { status: 'done', linkCount: queue.length, pagesDone: currentPage });
    await removeTab(PREFIX_COLLECT, tabId);
    await setTab(PREFIX_CRAWL, tabId, { queue, index: 0, location: crawlLocation || '' });
    return;
  }
  const nextPage = currentPage + 1;
  const nextUrl = baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'pn=' + nextPage;
  state.currentPage = nextPage;
  state.expectingUrl = nextUrl;
  await setTab(PREFIX_COLLECT, tabId, state);
  await setTab(PREFIX_CPROG, tabId, { status: 'collecting', currentPage: nextPage, linkCount: collectedUrls.length, maxRecords });
  await chrome.tabs.update(tabId, { url: nextUrl });
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  const state = await getTab(PREFIX_COLLECT, tabId);
  if (!state) return;
  if (!isSearchPageUrl(tab.url)) return;
  const expecting = state.expectingUrl;
  const urlNorm = tab.url.replace(/#.*$/, '');
  if (expecting && urlNorm !== expecting.replace(/#.*$/, '')) return;
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'GET_LISTING_LINKS' });
    const urls = (res && res.urls) || [];
    const seen = new Set(state.collectedUrls);
    urls.forEach((u) => { if (!seen.has(u)) { seen.add(u); state.collectedUrls.push(u); } });
    state.collectedUrls = Array.from(seen);
    state.expectingUrl = null;
    const done = state.collectedUrls.length >= state.maxRecords || (urls.length === 0 && state.collectedUrls.length > 0);
    if (done) {
      const queue = state.collectedUrls.slice(0, state.maxRecords);
      const crawlLocation = getLocationFromBaseUrl(state.baseUrl);
      await setTab(PREFIX_CPROG, tabId, { status: 'done', linkCount: queue.length, pagesDone: state.currentPage });
      await removeTab(PREFIX_COLLECT, tabId);
      await setTab(PREFIX_CRAWL, tabId, { queue, index: 0, location: crawlLocation || '' });
      return;
    }
    await setTab(PREFIX_CPROG, tabId, { status: 'collecting', currentPage: state.currentPage, linkCount: state.collectedUrls.length, maxRecords: state.maxRecords });
    await setTab(PREFIX_COLLECT, tabId, state);
    await runMultiPageCollectStep(tabId, state);
  } catch (e) {
    await removeTab(PREFIX_COLLECT, tabId);
    await setTab(PREFIX_CPROG, tabId, { status: 'error', error: e.message });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const run = async () => {
    if (msg.type === 'GET_COUNT') {
      return await count();
    }
    if (msg.type === 'GET_ALL') {
      return await getAll();
    }
    if (msg.type === 'SAVE_PROPERTY') {
      if (msg.data && msg.data.url) {
        await add(msg.data);
        await maybeAutoPushAfterSave(msg.tabId);
        return { ok: true };
      }
      return { ok: false };
    }
    if (msg.type === 'CLEAR_ALL') {
      await clearAllProperties();
      await removeAllWithPrefix(PREFIX_CFG);
      await removeAllWithPrefix(PREFIX_CRAWL);
      await removeAllWithPrefix(PREFIX_COLLECT);
      await removeAllWithPrefix(PREFIX_CPROG);
      return { ok: true };
    }
    if (msg.type === 'GET_CRAWL_CONFIG') {
      const tabId = msg.tabId;
      if (tabId == null) return { crawlConfig: null, configLocked: false };
      const cfg = await getTab(PREFIX_CFG, tabId);
      if (!cfg) return { crawlConfig: null, configLocked: false };
      return {
        crawlConfig: { maxRecords: cfg.maxRecords, autoPushEvery: cfg.autoPushEvery },
        configLocked: !!cfg.locked
      };
    }
    if (msg.type === 'SET_CRAWL_CONFIG_FOR_TAB') {
      const { tabId, maxRecords, autoPushEvery } = msg;
      if (tabId == null) return { ok: false };
      await setTab(PREFIX_CFG, tabId, {
        maxRecords: Math.max(1, Math.min(5000, maxRecords || 500)),
        autoPushEvery: Math.max(1, Math.min(1000, autoPushEvery || 50)),
        locked: true
      });
      return { ok: true };
    }
    if (msg.type === 'SET_QUEUE') {
      const tabId = msg.tabId;
      if (tabId == null) return { ok: false };
      await setTab(PREFIX_CRAWL, tabId, { queue: msg.urls || [], index: 0, location: msg.location || '' });
      return { ok: true };
    }
    if (msg.type === 'START_MULTI_PAGE_COLLECT') {
      const { tabId } = msg;
      if (!tabId) return { ok: false, error: 'Thiếu tab.' };
      const cfg = await getTab(PREFIX_CFG, tabId);
      if (!cfg || !cfg.locked) {
        return { ok: false, error: 'Chưa lưu config cho tab này. Nhập số bản ghi và đẩy tự động rồi bấm "Lưu config".' };
      }
      const maxRecords = Math.max(1, Math.min(5000, cfg.maxRecords || 500));
      let baseUrl, currentPage;
      try {
        const res = await chrome.tabs.sendMessage(tabId, { type: 'GET_SEARCH_BASE_URL' });
        if (!res || !res.baseUrl) {
          return { ok: false, error: 'Mở trang tìm kiếm Zoopla (for-sale/property/...) rồi thử lại.' };
        }
        baseUrl = res.baseUrl;
        currentPage = res.currentPage || 1;
      } catch (e) {
        return { ok: false, error: 'Không đọc được trang. Reload trang Zoopla rồi thử lại.' };
      }
      const state = { baseUrl, currentPage, maxRecords, collectedUrls: [], expectingUrl: null };
      await setTab(PREFIX_COLLECT, tabId, state);
      await setTab(PREFIX_CPROG, tabId, { status: 'collecting', currentPage: 1, linkCount: 0, maxRecords });
      const res = await chrome.tabs.sendMessage(tabId, { type: 'GET_LISTING_LINKS' });
      const urls = (res && res.urls) || [];
      state.collectedUrls = urls;
      state.currentPage = 1;
      if (state.collectedUrls.length >= state.maxRecords) {
        const queue = state.collectedUrls.slice(0, state.maxRecords);
        const crawlLocation = getLocationFromBaseUrl(state.baseUrl);
        await setTab(PREFIX_CPROG, tabId, { status: 'done', linkCount: queue.length, pagesDone: 1 });
        await removeTab(PREFIX_COLLECT, tabId);
        await setTab(PREFIX_CRAWL, tabId, { queue, index: 0, location: crawlLocation || '' });
        return { ok: true };
      }
      await runMultiPageCollectStep(tabId, state);
      return { ok: true };
    }
    if (msg.type === 'GET_COLLECTION_PROGRESS') {
      const tabId = msg.tabId;
      if (tabId == null) return null;
      return await getTab(PREFIX_CPROG, tabId);
    }
    if (msg.type === 'GET_CRAWL_STATE_FOR_TAB') {
      const tabId = msg.tabId;
      if (tabId == null) return { hasQueue: false, queueLength: 0, location: '' };
      const session = await getTab(PREFIX_CRAWL, tabId);
      if (!session || !session.queue) return { hasQueue: false, queueLength: 0, location: '' };
      return { hasQueue: true, queueLength: session.queue.length, location: session.location || '' };
    }
    if (msg.type === 'GET_ACTIVE_CRAWL_TABS') {
      const allCrawl = await getAllWithPrefix(PREFIX_CRAWL);
      const list = [];
      for (const tabIdStr of Object.keys(allCrawl)) {
        const session = allCrawl[tabIdStr];
        if (!session || !session.queue || session.queue.length === 0) continue;
        const tabId = parseInt(tabIdStr, 10);
        if (Number.isNaN(tabId)) continue;
        try {
          const tab = await chrome.tabs.get(tabId);
          list.push({
            tabId: tab.id,
            windowId: tab.windowId,
            title: tab.title || 'Tab ' + tab.id,
            location: session.location || '',
            queueLength: session.queue.length,
            currentIndex: session.index != null ? session.index : 0
          });
        } catch (e) {}
      }
      return { tabs: list };
    }
    if (msg.type === 'START_CRAWL_TAB') {
      const tabId = msg.tabId;
      const session = await getTab(PREFIX_CRAWL, tabId);
      if (!session || !session.queue || session.queue.length === 0) {
        return { ok: false, error: 'Chưa có danh sách link trong tab này. Thu thập link trong tab này trước.' };
      }
      const { queue, location: crawlLocation } = session;
      const existingSet = await fetchExistingUrlsFromBackend(queue);
      const toCrawl = existingSet.size > 0 ? queue.filter((u) => !existingSet.has(u)) : queue;
      if (toCrawl.length === 0) {
        return { ok: false, error: 'Tất cả ' + queue.length + ' link đã có trong database. Không cần crawl lại.' };
      }
      await setTab(PREFIX_CRAWL, tabId, { queue: toCrawl, index: 0, location: crawlLocation || '' });
      await chrome.tabs.update(tabId, { url: toCrawl[0] });
      return { ok: true, skipped: queue.length - toCrawl.length, total: toCrawl.length };
    }
    if (msg.type === 'PAGE_LOADED') {
      const tabId = sender.tab?.id;
      if (tabId == null) return null;
      const session = await getTab(PREFIX_CRAWL, tabId);
      if (!session || !session.queue || session.queue.length === 0) return null;
      const { queue, index: crawlIndex, location: crawlLocation } = session;
      if (msg.url !== queue[crawlIndex]) return null;
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const res = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_CURRENT_PAGE' });
        if (res && res.data) {
          if (crawlLocation && crawlLocation.trim()) res.data.city = crawlLocation.trim();
          await add(res.data);
          await maybeAutoPushAfterSave(tabId);
        }
      } catch (e) {}
      const nextIndex = crawlIndex + 1;
      if (nextIndex < queue.length) {
        await setTab(PREFIX_CRAWL, tabId, { queue, index: nextIndex, location: crawlLocation || '' });
        await chrome.tabs.update(tabId, { url: queue[nextIndex] });
      } else {
        await pushRemainderToBackend(tabId);
      }
      return { ok: true };
    }
    if (msg.type === 'SEND_TO_BACKEND') {
      const { backendUrl } = await chrome.storage.sync.get('backendUrl');
      if (!backendUrl || !backendUrl.trim()) {
        return { ok: false, error: 'Chưa cấu hình Backend URL trong Cài đặt.' };
      }
      const rows = await getAll();
      if (rows.length === 0) {
        return { ok: true, sent: 0 };
      }
      const url = backendUrl.replace(/\/$/, '') + '/api/properties';
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ properties: rows })
        });
        if (!res.ok) {
          const text = await res.text();
          return { ok: false, error: 'HTTP ' + res.status + ': ' + text.slice(0, 200) };
        }
        return { ok: true, sent: rows.length };
      } catch (e) {
        return { ok: false, error: e.message || 'Network error' };
      }
    }
    return null;
  };
  run().then(sendResponse).catch((e) => sendResponse(null));
  return true;
});

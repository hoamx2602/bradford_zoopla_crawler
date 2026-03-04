const DB_NAME = 'zoopla_crawler_db';
const STORE = 'properties';

const COLLECT_STATE_KEY = 'multiPageCollectState';
const COLLECT_PROGRESS_KEY = 'collectionProgress';
const CRAWL_CONFIG_KEY = 'crawlConfig';
const CONFIG_LOCKED_KEY = 'configLocked';
const CRAWL_CONFIG_BY_TAB_KEY = 'crawlConfigByTab';
const CRAWL_STATE_BY_TAB_KEY = 'crawlStateByTab';

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
  const o = await chrome.storage.local.get(CRAWL_CONFIG_BY_TAB_KEY);
  const byTab = o[CRAWL_CONFIG_BY_TAB_KEY] || {};
  const cfg = byTab[String(tabId)];
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

/** Đẩy toàn bộ bản ghi còn lại lên backend (khi crawl xong mà số lượng < autoPushEvery). Chỉ xóa state của tab này, không xóa config hay tab khác. */
async function pushRemainderToBackend(tabId) {
  const cnt = await count();
  if (cnt === 0) {
    await clearCrawlStateForTab(tabId);
    return;
  }
  const o = await chrome.storage.local.get(CRAWL_CONFIG_BY_TAB_KEY);
  const cfg = (o[CRAWL_CONFIG_BY_TAB_KEY] || {})[String(tabId)];
  if (!cfg || !cfg.locked) {
    await clearCrawlStateForTab(tabId);
    return;
  }
  const { backendUrl } = await chrome.storage.sync.get('backendUrl');
  if (!backendUrl || !backendUrl.trim()) {
    await clearCrawlStateForTab(tabId);
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
      await clearCrawlStateForTab(tabId);
    }
  } catch (e) {}
}

/** Chỉ xóa crawl state của một tab (để tab khác tiếp tục crawl). */
async function clearCrawlStateForTab(tabId) {
  const key = String(tabId);
  const o = await chrome.storage.local.get(CRAWL_STATE_BY_TAB_KEY);
  const byTab = o[CRAWL_STATE_BY_TAB_KEY] || {};
  delete byTab[key];
  await chrome.storage.local.set({ [CRAWL_STATE_BY_TAB_KEY]: byTab });
}

/** Gọi backend để lấy danh sách URL đã có trong DB, trả về Set. */
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

/** Lấy city từ URL dạng .../for-sale/property/ickenham/ -> Ickenham */
function getLocationFromBaseUrl(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') return null;
  const m = baseUrl.match(/\/property\/([^/?]+)/);
  return m ? m[1].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : null;
}

async function runMultiPageCollectStep(tabId, state) {
  const { baseUrl, currentPage, maxRecords, collectedUrls } = state;
  const done = collectedUrls.length >= maxRecords;
  if (done) {
    const queue = collectedUrls.slice(0, maxRecords);
    const crawlLocation = getLocationFromBaseUrl(baseUrl);
    const o = await chrome.storage.local.get(CRAWL_STATE_BY_TAB_KEY);
    const byTab = o[CRAWL_STATE_BY_TAB_KEY] || {};
    byTab[String(tabId)] = { queue, index: 0, location: crawlLocation || '' };
    await chrome.storage.local.set({ [CRAWL_STATE_BY_TAB_KEY]: byTab });
    await chrome.storage.local.remove([COLLECT_STATE_KEY]);
    await chrome.storage.local.set({
      [COLLECT_PROGRESS_KEY]: {
        status: 'done',
        linkCount: queue.length,
        pagesDone: currentPage
      }
    });
    return;
  }
  const nextPage = currentPage + 1;
  const nextUrl = baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'pn=' + nextPage;
  state.currentPage = nextPage;
  state.expectingUrl = nextUrl;
  await chrome.storage.local.set({ [COLLECT_STATE_KEY]: state });
  await chrome.storage.local.set({
    [COLLECT_PROGRESS_KEY]: {
      status: 'collecting',
      currentPage: nextPage,
      linkCount: collectedUrls.length,
      maxRecords
    }
  });
  await chrome.tabs.update(tabId, { url: nextUrl });
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  const raw = await chrome.storage.local.get(COLLECT_STATE_KEY);
  const state = raw[COLLECT_STATE_KEY];
  if (!state || state.tabId !== tabId) return;
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
      const o = await chrome.storage.local.get(CRAWL_STATE_BY_TAB_KEY);
      const byTab = o[CRAWL_STATE_BY_TAB_KEY] || {};
      byTab[String(tabId)] = { queue, index: 0, location: crawlLocation || '' };
      await chrome.storage.local.set({ [CRAWL_STATE_BY_TAB_KEY]: byTab });
      await chrome.storage.local.remove([COLLECT_STATE_KEY]);
      await chrome.storage.local.set({
        [COLLECT_PROGRESS_KEY]: {
          status: 'done',
          linkCount: queue.length,
          pagesDone: state.currentPage
        }
      });
      return;
    }
    await chrome.storage.local.set({
      [COLLECT_PROGRESS_KEY]: {
        status: 'collecting',
        currentPage: state.currentPage,
        linkCount: state.collectedUrls.length,
        maxRecords: state.maxRecords
      }
    });
    await chrome.storage.local.set({ [COLLECT_STATE_KEY]: state });
    await runMultiPageCollectStep(tabId, state);
  } catch (e) {
    await chrome.storage.local.remove([COLLECT_STATE_KEY]);
    await chrome.storage.local.set({
      [COLLECT_PROGRESS_KEY]: { status: 'error', error: e.message }
    });
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
      await chrome.storage.local.remove([
        CRAWL_CONFIG_KEY, CONFIG_LOCKED_KEY, CRAWL_CONFIG_BY_TAB_KEY, CRAWL_STATE_BY_TAB_KEY,
        COLLECT_STATE_KEY, COLLECT_PROGRESS_KEY
      ]);
      return { ok: true };
    }
    if (msg.type === 'GET_CRAWL_CONFIG') {
      const tabId = msg.tabId;
      if (tabId == null) return { crawlConfig: null, configLocked: false };
      const o = await chrome.storage.local.get(CRAWL_CONFIG_BY_TAB_KEY);
      const byTab = o[CRAWL_CONFIG_BY_TAB_KEY] || {};
      const cfg = byTab[String(tabId)];
      if (!cfg) return { crawlConfig: null, configLocked: false };
      return {
        crawlConfig: { maxRecords: cfg.maxRecords, autoPushEvery: cfg.autoPushEvery },
        configLocked: !!cfg.locked
      };
    }
    if (msg.type === 'SET_CRAWL_CONFIG_FOR_TAB') {
      const { tabId, maxRecords, autoPushEvery } = msg;
      if (tabId == null) return { ok: false };
      const o = await chrome.storage.local.get(CRAWL_CONFIG_BY_TAB_KEY);
      const byTab = o[CRAWL_CONFIG_BY_TAB_KEY] || {};
      byTab[String(tabId)] = {
        maxRecords: Math.max(1, Math.min(5000, maxRecords || 500)),
        autoPushEvery: Math.max(1, Math.min(1000, autoPushEvery || 50)),
        locked: true
      };
      await chrome.storage.local.set({ [CRAWL_CONFIG_BY_TAB_KEY]: byTab });
      return { ok: true };
    }
    if (msg.type === 'SET_QUEUE') {
      const tabId = msg.tabId;
      if (tabId == null) return { ok: false };
      const o = await chrome.storage.local.get(CRAWL_STATE_BY_TAB_KEY);
      const byTab = o[CRAWL_STATE_BY_TAB_KEY] || {};
      byTab[String(tabId)] = { queue: msg.urls || [], index: 0, location: msg.location || '' };
      await chrome.storage.local.set({ [CRAWL_STATE_BY_TAB_KEY]: byTab });
      return { ok: true };
    }
    if (msg.type === 'START_MULTI_PAGE_COLLECT') {
      const { tabId } = msg;
      if (!tabId) return { ok: false, error: 'Thiếu tab.' };
      const o = await chrome.storage.local.get(CRAWL_CONFIG_BY_TAB_KEY);
      const cfg = (o[CRAWL_CONFIG_BY_TAB_KEY] || {})[String(tabId)];
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
      const state = {
        tabId,
        baseUrl,
        currentPage,
        maxRecords,
        collectedUrls: [],
        expectingUrl: null
      };
      await chrome.storage.local.set({ [COLLECT_STATE_KEY]: state });
      await chrome.storage.local.set({
        [COLLECT_PROGRESS_KEY]: { status: 'collecting', currentPage: 1, linkCount: 0, maxRecords }
      });
      const res = await chrome.tabs.sendMessage(tabId, { type: 'GET_LISTING_LINKS' });
      const urls = (res && res.urls) || [];
      state.collectedUrls = urls;
      state.currentPage = 1;
      if (state.collectedUrls.length >= state.maxRecords) {
        const queue = state.collectedUrls.slice(0, state.maxRecords);
        const crawlLocation = getLocationFromBaseUrl(state.baseUrl);
        const o = await chrome.storage.local.get(CRAWL_STATE_BY_TAB_KEY);
        const byTab = o[CRAWL_STATE_BY_TAB_KEY] || {};
        byTab[String(tabId)] = { queue, index: 0, location: crawlLocation || '' };
        await chrome.storage.local.set({ [CRAWL_STATE_BY_TAB_KEY]: byTab });
        await chrome.storage.local.remove([COLLECT_STATE_KEY]);
        await chrome.storage.local.set({
          [COLLECT_PROGRESS_KEY]: { status: 'done', linkCount: queue.length, pagesDone: 1 }
        });
        return { ok: true };
      }
      await runMultiPageCollectStep(tabId, state);
      return { ok: true };
    }
    if (msg.type === 'GET_COLLECTION_PROGRESS') {
      const o = await chrome.storage.local.get(COLLECT_PROGRESS_KEY);
      return o[COLLECT_PROGRESS_KEY] || null;
    }
    if (msg.type === 'GET_CRAWL_STATE_FOR_TAB') {
      const tabId = msg.tabId;
      if (tabId == null) return { hasQueue: false, queueLength: 0, location: '' };
      const o = await chrome.storage.local.get(CRAWL_STATE_BY_TAB_KEY);
      const byTab = o[CRAWL_STATE_BY_TAB_KEY] || {};
      const session = byTab[String(tabId)];
      if (!session || !session.queue) return { hasQueue: false, queueLength: 0, location: '' };
      return { hasQueue: true, queueLength: session.queue.length, location: session.location || '' };
    }
    if (msg.type === 'GET_ACTIVE_CRAWL_TABS') {
      const o = await chrome.storage.local.get(CRAWL_STATE_BY_TAB_KEY);
      const byTab = o[CRAWL_STATE_BY_TAB_KEY] || {};
      const list = [];
      for (const tabIdStr of Object.keys(byTab)) {
        const session = byTab[tabIdStr];
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
        } catch (e) {
          // Tab đã đóng, bỏ qua
        }
      }
      return { tabs: list };
    }
    if (msg.type === 'START_CRAWL_TAB') {
      const tabId = msg.tabId;
      const o = await chrome.storage.local.get(CRAWL_STATE_BY_TAB_KEY);
      const byTab = o[CRAWL_STATE_BY_TAB_KEY] || {};
      const session = byTab[String(tabId)];
      if (!session || !session.queue || session.queue.length === 0) {
        return { ok: false, error: 'Chưa có danh sách link trong tab này. Thu thập link trong tab này trước.' };
      }
      const { queue, location: crawlLocation } = session;
      const existingSet = await fetchExistingUrlsFromBackend(queue);
      const toCrawl = existingSet.size > 0 ? queue.filter((u) => !existingSet.has(u)) : queue;
      if (toCrawl.length === 0) {
        return { ok: false, error: 'Tất cả ' + queue.length + ' link đã có trong database. Không cần crawl lại.' };
      }
      byTab[String(tabId)] = { queue: toCrawl, index: 0, location: crawlLocation || '' };
      await chrome.storage.local.set({ [CRAWL_STATE_BY_TAB_KEY]: byTab });
      await chrome.tabs.update(tabId, { url: toCrawl[0] });
      return { ok: true, skipped: queue.length - toCrawl.length, total: toCrawl.length };
    }
    if (msg.type === 'PAGE_LOADED') {
      const tabId = sender.tab?.id;
      if (tabId == null) return null;
      const o = await chrome.storage.local.get(CRAWL_STATE_BY_TAB_KEY);
      const byTab = o[CRAWL_STATE_BY_TAB_KEY] || {};
      const session = byTab[String(tabId)];
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
        byTab[String(tabId)] = { queue, index: nextIndex, location: crawlLocation || '' };
        await chrome.storage.local.set({ [CRAWL_STATE_BY_TAB_KEY]: byTab });
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

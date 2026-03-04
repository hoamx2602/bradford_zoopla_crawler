const DB_NAME = 'zoopla_crawler_db';
const STORE = 'properties';

const COLLECT_STATE_KEY = 'multiPageCollectState';
const COLLECT_PROGRESS_KEY = 'collectionProgress';
const CRAWL_CONFIG_KEY = 'crawlConfig';
const CONFIG_LOCKED_KEY = 'configLocked';

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

async function maybeAutoPushAfterSave() {
  const cnt = await count();
  const { crawlConfig, configLocked } = await chrome.storage.local.get([CRAWL_CONFIG_KEY, CONFIG_LOCKED_KEY]);
  const { backendUrl } = await chrome.storage.sync.get('backendUrl');
  const every = (crawlConfig && crawlConfig.autoPushEvery) ? Math.max(1, crawlConfig.autoPushEvery) : 0;
  if (!configLocked || every <= 0 || !backendUrl || !backendUrl.trim() || cnt < every || cnt % every !== 0) return;
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

/** Đẩy toàn bộ bản ghi còn lại lên backend (khi crawl xong mà số lượng < autoPushEvery). */
async function pushRemainderToBackend() {
  const cnt = await count();
  if (cnt === 0) return;
  const { configLocked } = await chrome.storage.local.get(CONFIG_LOCKED_KEY);
  const { backendUrl } = await chrome.storage.sync.get('backendUrl');
  if (!configLocked || !backendUrl || !backendUrl.trim()) return;
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
      await chrome.storage.local.remove([
        CRAWL_CONFIG_KEY, CONFIG_LOCKED_KEY, 'crawlQueue', 'crawlIndex', 'crawlTabId', 'crawlLocation',
        COLLECT_STATE_KEY, COLLECT_PROGRESS_KEY
      ]);
    }
  } catch (e) {}
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
    await chrome.storage.local.set({ crawlQueue: queue, crawlLocation: crawlLocation || '' });
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
      await chrome.storage.local.set({ crawlQueue: queue, crawlLocation: crawlLocation || '' });
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
        await maybeAutoPushAfterSave();
        return { ok: true };
      }
      return { ok: false };
    }
    if (msg.type === 'CLEAR_ALL') {
      await clearAllProperties();
      await chrome.storage.local.remove([
        CRAWL_CONFIG_KEY, CONFIG_LOCKED_KEY, 'crawlQueue', 'crawlIndex', 'crawlTabId', 'crawlLocation',
        COLLECT_STATE_KEY, COLLECT_PROGRESS_KEY
      ]);
      return { ok: true };
    }
    if (msg.type === 'GET_CRAWL_CONFIG') {
      const o = await chrome.storage.local.get([CRAWL_CONFIG_KEY, CONFIG_LOCKED_KEY]);
      return { crawlConfig: o[CRAWL_CONFIG_KEY] || null, configLocked: !!o[CONFIG_LOCKED_KEY] };
    }
    if (msg.type === 'SET_QUEUE') {
      await chrome.storage.local.set({ crawlQueue: msg.urls || [] });
      return { ok: true };
    }
    if (msg.type === 'START_MULTI_PAGE_COLLECT') {
      const { tabId } = msg;
      if (!tabId) return { ok: false, error: 'Thiếu tab.' };
      const { crawlConfig, configLocked } = await chrome.storage.local.get([CRAWL_CONFIG_KEY, CONFIG_LOCKED_KEY]);
      if (!configLocked || !crawlConfig) {
        return { ok: false, error: 'Chưa lưu config. Nhập số bản ghi và đẩy tự động rồi bấm "Lưu config".' };
      }
      const maxRecords = Math.max(1, Math.min(5000, crawlConfig.maxRecords || 500));
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
        await chrome.storage.local.set({ crawlQueue: queue, crawlLocation: crawlLocation || '' });
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
    if (msg.type === 'START_CRAWL_TAB') {
      const { crawlQueue, crawlLocation } = await chrome.storage.local.get(['crawlQueue', 'crawlLocation']);
      if (!crawlQueue || crawlQueue.length === 0) {
        return { ok: false, error: 'Chưa có danh sách link. Thu thập link trước.' };
      }
      await chrome.storage.local.set({
        crawlQueue,
        crawlIndex: 0,
        crawlTabId: msg.tabId,
        crawlLocation: crawlLocation || ''
      });
      await chrome.tabs.update(msg.tabId, { url: crawlQueue[0] });
      return { ok: true };
    }
    if (msg.type === 'PAGE_LOADED') {
      const { crawlQueue, crawlIndex, crawlTabId, crawlLocation } = await chrome.storage.local.get(['crawlQueue', 'crawlIndex', 'crawlTabId', 'crawlLocation']);
      if (!crawlQueue || sender.tab?.id !== crawlTabId || msg.url !== crawlQueue[crawlIndex]) {
        return null;
      }
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const res = await chrome.tabs.sendMessage(sender.tab.id, { type: 'EXTRACT_CURRENT_PAGE' });
        if (res && res.data) {
          if (crawlLocation && crawlLocation.trim()) res.data.city = crawlLocation.trim();
          await add(res.data);
          await maybeAutoPushAfterSave();
        }
      } catch (e) {}
      const nextIndex = crawlIndex + 1;
      if (nextIndex < crawlQueue.length) {
        await chrome.storage.local.set({ crawlIndex: nextIndex });
        await chrome.tabs.update(sender.tab.id, { url: crawlQueue[nextIndex] });
      } else {
        await pushRemainderToBackend();
        await chrome.storage.local.remove(['crawlQueue', 'crawlIndex', 'crawlTabId', 'crawlLocation']);
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

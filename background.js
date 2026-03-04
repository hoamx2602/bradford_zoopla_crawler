const DB_NAME = 'zoopla_crawler_db';
const STORE = 'properties';

const COLLECT_STATE_KEY = 'multiPageCollectState';
const COLLECT_PROGRESS_KEY = 'collectionProgress';

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

function isSearchPageUrl(url) {
  return url && /zoopla\.co\.uk\/for-sale\/property\/[^/]+\/?/.test(url) && !/\/for-sale\/details\/\d+/.test(url);
}

async function runMultiPageCollectStep(tabId, state) {
  const { baseUrl, currentPage, maxPages, maxRecords, collectedUrls } = state;
  const done = currentPage > maxPages || collectedUrls.length >= maxRecords;
  if (done) {
    await chrome.storage.local.set({ crawlQueue: collectedUrls });
    await chrome.storage.local.remove([COLLECT_STATE_KEY]);
    await chrome.storage.local.set({
      [COLLECT_PROGRESS_KEY]: {
        status: 'done',
        linkCount: collectedUrls.length,
        pagesDone: currentPage - 1
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
      maxPages,
      linkCount: collectedUrls.length
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
    await chrome.storage.local.set({
      [COLLECT_PROGRESS_KEY]: {
        status: state.currentPage >= state.maxPages || state.collectedUrls.length >= state.maxRecords ? 'done' : 'collecting',
        currentPage: state.currentPage,
        maxPages: state.maxPages,
        linkCount: state.collectedUrls.length
      }
    });
    const done = state.currentPage >= state.maxPages || state.collectedUrls.length >= state.maxRecords;
    if (done) {
      await chrome.storage.local.set({ crawlQueue: state.collectedUrls });
      await chrome.storage.local.remove([COLLECT_STATE_KEY]);
      await chrome.storage.local.set({
        [COLLECT_PROGRESS_KEY]: {
          status: 'done',
          linkCount: state.collectedUrls.length,
          pagesDone: state.currentPage
        }
      });
      return;
    }
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
        return { ok: true };
      }
      return { ok: false };
    }
    if (msg.type === 'SET_QUEUE') {
      await chrome.storage.local.set({ crawlQueue: msg.urls || [] });
      return { ok: true };
    }
    if (msg.type === 'START_MULTI_PAGE_COLLECT') {
      const { maxPages = 5, maxRecords = 500, tabId } = msg;
      if (!tabId) return { ok: false, error: 'Thiếu tab.' };
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
        maxPages: Math.max(1, Math.min(100, maxPages)),
        maxRecords: Math.max(1, Math.min(5000, maxRecords)),
        collectedUrls: [],
        expectingUrl: null
      };
      await chrome.storage.local.set({ [COLLECT_STATE_KEY]: state });
      await chrome.storage.local.set({
        [COLLECT_PROGRESS_KEY]: { status: 'collecting', currentPage: 1, maxPages: state.maxPages, linkCount: 0 }
      });
      const res = await chrome.tabs.sendMessage(tabId, { type: 'GET_LISTING_LINKS' });
      const urls = (res && res.urls) || [];
      state.collectedUrls = urls;
      state.currentPage = 1;
      if (state.collectedUrls.length >= state.maxRecords || state.currentPage >= state.maxPages) {
        await chrome.storage.local.set({ crawlQueue: state.collectedUrls });
        await chrome.storage.local.remove([COLLECT_STATE_KEY]);
        await chrome.storage.local.set({
          [COLLECT_PROGRESS_KEY]: { status: 'done', linkCount: state.collectedUrls.length, pagesDone: 1 }
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
      const { crawlQueue } = await chrome.storage.local.get('crawlQueue');
      if (!crawlQueue || crawlQueue.length === 0) {
        return { ok: false, error: 'Chưa có danh sách link. Thu thập link trước.' };
      }
      await chrome.storage.local.set({
        crawlQueue,
        crawlIndex: 0,
        crawlTabId: msg.tabId
      });
      await chrome.tabs.update(msg.tabId, { url: crawlQueue[0] });
      return { ok: true };
    }
    if (msg.type === 'PAGE_LOADED') {
      const { crawlQueue, crawlIndex, crawlTabId } = await chrome.storage.local.get(['crawlQueue', 'crawlIndex', 'crawlTabId']);
      if (!crawlQueue || sender.tab?.id !== crawlTabId || msg.url !== crawlQueue[crawlIndex]) {
        return null;
      }
      await new Promise((r) => setTimeout(r, 2500));
      try {
        const res = await chrome.tabs.sendMessage(sender.tab.id, { type: 'EXTRACT_CURRENT_PAGE' });
        if (res && res.data) {
          await add(res.data);
        }
      } catch (e) {}
      const nextIndex = crawlIndex + 1;
      if (nextIndex < crawlQueue.length) {
        await chrome.storage.local.set({ crawlIndex: nextIndex });
        await chrome.tabs.update(sender.tab.id, { url: crawlQueue[nextIndex] });
      } else {
        await chrome.storage.local.remove(['crawlQueue', 'crawlIndex', 'crawlTabId']);
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

const DB_NAME = 'zoopla_crawler_db';
const STORE = 'properties';

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
    if (msg.type === 'START_CRAWL_TAB') {
      const { crawlQueue } = await chrome.storage.local.get('crawlQueue');
      if (!crawlQueue || crawlQueue.length === 0) {
        return { ok: false, error: 'Chưa có danh sách link. Bấm "Lấy danh sách link" trước.' };
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

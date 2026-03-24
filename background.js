const DB_NAME = 'zoopla_crawler_db';
const STORE = 'properties';

const PREFIX_CFG = 'cfg_';
const PREFIX_CRAWL = 'crawl_';
const PREFIX_COLLECT = 'collect_';
const PREFIX_CPROG = 'cprog_';
const PREFIX_BATCH = 'batch_';

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

function toCsv(rows) {
  const keys = ['url', 'city', 'postcode', 'price', 'address', 'property_type', 'bedrooms', 'bathrooms', 'living_rooms', 'area_sqft', 'description', 'epc_rating'];
  const header = keys.join(',');
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s + '"' : s;
  };
  return [header].concat(rows.map((r) => keys.map((k) => escape(r[k])).join(','))).join('\n');
}

async function maybeAutoExportCsv(tabId) {
  const { backendUrl, autoExportEvery } = await chrome.storage.sync.get(['backendUrl', 'autoExportEvery']);
  if (backendUrl && backendUrl.trim()) return;
  const every = Math.max(1, Math.min(1000, parseInt(autoExportEvery, 10) || 1000));
  const cnt = await count();
  if (cnt < every) return;
  const rows = await getAll();
  if (rows.length === 0) return;
  const csv = '\ufeff' + toCsv(rows);
  const base64 = btoa(unescape(encodeURIComponent(csv)));
  const dataUrl = 'data:text/csv;charset=utf-8;base64,' + base64;
  const now = new Date();
  const filename = 'zoopla_export_' + now.toISOString().slice(0, 10) + '_' + String(now.getHours()).padStart(2, '0') + '-' + String(now.getMinutes()).padStart(2, '0') + '.csv';
  try {
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
  } catch (e) {}
  await clearAllProperties();
}

/** Export all current records to CSV and download, then clear local (used when crawl ends without backend). */
async function exportRemainderToCsvAndClear() {
  const cnt = await count();
  if (cnt === 0) return;
  const rows = await getAll();
  const csv = '\ufeff' + toCsv(rows);
  const base64 = btoa(unescape(encodeURIComponent(csv)));
  const dataUrl = 'data:text/csv;charset=utf-8;base64,' + base64;
  const now = new Date();
  const filename = 'zoopla_export_' + now.toISOString().slice(0, 10) + '_' + String(now.getHours()).padStart(2, '0') + '-' + String(now.getMinutes()).padStart(2, '0') + '.csv';
  try {
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
  } catch (e) {}
  await clearAllProperties();
}

async function pushRemainderToBackend(tabId) {
  const cnt = await count();
  if (cnt === 0) {
    await removeTab(PREFIX_CRAWL, tabId);
    return;
  }
  const { backendUrl } = await chrome.storage.sync.get('backendUrl');
  if (!backendUrl || !backendUrl.trim()) {
    await exportRemainderToCsvAndClear();
    await removeTab(PREFIX_CRAWL, tabId);
    return;
  }
  const cfg = await getTab(PREFIX_CFG, tabId);
  if (!cfg || !cfg.locked) {
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
    const chunkUrls = chunk.map(u => typeof u === 'object' ? u.url : u);
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: chunkUrls })
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
  let postcode = null;
  let city = null;
  try {
    const u = new URL(baseUrl);
    const q = u.searchParams.get('q');
    if (q && q.trim()) postcode = q.trim().toUpperCase();
  } catch (e) {}
  const m = baseUrl.match(/\/for-sale\/property\/([^/?]+)/);
  if (m) {
    city = m[1].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return (city || postcode) ? { city, postcode } : null;
}

async function runMultiPageCollectStep(tabId, state) {
  const { baseUrl, currentPage, maxRecords, collectedUrls } = state;
  if (collectedUrls.length >= maxRecords) {
    const queue = collectedUrls.slice(0, maxRecords);
    const crawlLocation = getLocationFromBaseUrl(baseUrl);

    // Check if it was part of a batch
    const batch = await getTab(PREFIX_BATCH, tabId);
    if (batch) {
      const currentLoc = getLocationFromBaseUrl(baseUrl) || {};
      const tagged = queue.map(u => ({ 
        url: u, 
        city: batch.city || currentLoc.city, 
        postcode: currentLoc.postcode 
      }));
      batch.accumulatedUrls = [...(batch.accumulatedUrls || []), ...tagged];
      batch.currentIndex++;
      if (batch.currentIndex < batch.postcodes.length) {
        await setTab(PREFIX_BATCH, tabId, batch);
        const nextPc = batch.postcodes[batch.currentIndex].toLowerCase();
        const nextSearchUrl = `https://www.zoopla.co.uk/for-sale/property/${nextPc}/?q=${nextPc.toUpperCase()}&search_source=for-sale`;
        
        // Reset state for the new postcode
        state.baseUrl = nextSearchUrl;
        state.currentPage = 1;
        state.expectingUrl = nextSearchUrl;
        state.collectedUrls = [];
        await setTab(PREFIX_COLLECT, tabId, state);

        await setTab(PREFIX_CPROG, tabId, {
          status: 'collecting',
          currentPage: 1,
          linkCount: batch.accumulatedUrls.length,
          maxRecords: `Batch (${batch.currentIndex + 1}/${batch.postcodes.length})`
        });
        await chrome.tabs.update(tabId, { url: nextSearchUrl });
        return;
      } else {
        // Batch complete
        const finalQueue = batch.accumulatedUrls.slice(0, maxRecords);
        await setTab(PREFIX_CPROG, tabId, { status: 'done', linkCount: finalQueue.length, pagesDone: 'Batch Complete' });
        await removeTab(PREFIX_BATCH, tabId);
        await removeTab(PREFIX_COLLECT, tabId);
        await setTab(PREFIX_CRAWL, tabId, { queue: finalQueue, index: 0, location: 'Batch' });
        return;
      }
    }

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

  // When updating progress, show total (accumulated + current)
  const batch = await getTab(PREFIX_BATCH, tabId);
  const totalCount = (batch ? (batch.accumulatedUrls || []).length : 0) + collectedUrls.length;
  await setTab(PREFIX_CPROG, tabId, { 
    status: 'collecting', 
    currentPage: nextPage, 
    linkCount: totalCount, 
    maxRecords: batch ? `Batch (${batch.currentIndex + 1}/${batch.postcodes.length})` : maxRecords 
  });
  
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
    const done = state.collectedUrls.length >= state.maxRecords || (urls.length === 0 && state.collectedUrls.length > 0) || (urls.length === 0 && state.currentPage > 1);
    if (done) {
      const queue = state.collectedUrls; // Don't slice yet if in batch
      const crawlLocation = getLocationFromBaseUrl(state.baseUrl);

      const batch = await getTab(PREFIX_BATCH, tabId);
      if (batch) {
        const currentLoc = getLocationFromBaseUrl(state.baseUrl) || {};
        const tagged = queue.map(u => ({ 
          url: u, 
          city: batch.city || currentLoc.city, 
          postcode: currentLoc.postcode 
        }));
        batch.accumulatedUrls = [...(batch.accumulatedUrls || []), ...tagged];
        batch.currentIndex++;
        if (batch.currentIndex < batch.postcodes.length) {
          await setTab(PREFIX_BATCH, tabId, batch);
          const nextPc = batch.postcodes[batch.currentIndex].toLowerCase();
          const nextSearchUrl = `https://www.zoopla.co.uk/for-sale/property/${nextPc}/?q=${nextPc.toUpperCase()}&search_source=for-sale`;
          
          // Reset state for next postcode in batch
          state.baseUrl = nextSearchUrl;
          state.currentPage = 1;
          state.expectingUrl = nextSearchUrl;
          state.collectedUrls = [];
          await setTab(PREFIX_COLLECT, tabId, state);

          await setTab(PREFIX_CPROG, tabId, {
            status: 'collecting',
            currentPage: 1,
            linkCount: batch.accumulatedUrls.length,
            maxRecords: `Batch (${batch.currentIndex + 1}/${batch.postcodes.length})`
          });
          await chrome.tabs.update(tabId, { url: nextSearchUrl });
          return;
        } else {
          // Batch complete
          const finalQueue = batch.accumulatedUrls.slice(0, state.maxRecords);
          await setTab(PREFIX_CPROG, tabId, { status: 'done', linkCount: finalQueue.length, pagesDone: 'Batch Complete' });
          await removeTab(PREFIX_BATCH, tabId);
          await removeTab(PREFIX_COLLECT, tabId);
          await setTab(PREFIX_CRAWL, tabId, { queue: finalQueue, index: 0, location: 'Batch' });
          return;
        }
      }

      const finalQueue = queue.slice(0, state.maxRecords);
      await setTab(PREFIX_CPROG, tabId, { status: 'done', linkCount: finalQueue.length, pagesDone: state.currentPage });
      await removeTab(PREFIX_COLLECT, tabId);
      await setTab(PREFIX_CRAWL, tabId, { queue: finalQueue, index: 0, location: crawlLocation || '' });
      return;
    }
    const batch = await getTab(PREFIX_BATCH, tabId);
    const totalCount = (batch ? (batch.accumulatedUrls || []).length : 0) + state.collectedUrls.length;
    
    // If total reached, we can stop the whole process
    if (totalCount >= state.maxRecords) {
       // Force done
       const needed = state.maxRecords - (batch ? batch.accumulatedUrls.length : 0);
       const lastLinks = state.collectedUrls.slice(0, needed);
       if (batch) {
          const currentLoc = getLocationFromBaseUrl(state.baseUrl) || {};
          const tagged = lastLinks.map(u => ({ url: u, city: batch.city || currentLoc.city, postcode: currentLoc.postcode }));
          batch.accumulatedUrls = [...(batch.accumulatedUrls || []), ...tagged];
          const finalQueue = batch.accumulatedUrls.slice(0, state.maxRecords);
          await setTab(PREFIX_CPROG, tabId, { status: 'done', linkCount: finalQueue.length, pagesDone: 'Limit Reached' });
          await removeTab(PREFIX_BATCH, tabId);
          await removeTab(PREFIX_COLLECT, tabId);
          await setTab(PREFIX_CRAWL, tabId, { queue: finalQueue, index: 0, location: batch.city || 'Batch' });
          return;
       }
    }

    await setTab(PREFIX_CPROG, tabId, { 
       status: 'collecting', 
       currentPage: state.currentPage, 
       linkCount: totalCount, 
       maxRecords: batch ? `Batch (${batch.currentIndex + 1}/${batch.postcodes.length})` : state.maxRecords 
    });
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
        await maybeAutoExportCsv(msg.tabId);
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
      if (!tabId) return { ok: false, error: 'Missing tab.' };
      const cfg = await getTab(PREFIX_CFG, tabId);
      if (!cfg || !cfg.locked) {
        return { ok: false, error: 'Save config for this tab first. Enter max records and auto-push, then click "Save config".' };
      }
      const maxRecords = Math.max(1, Math.min(5000, cfg.maxRecords || 500));
      let baseUrl, currentPage;
      try {
        const res = await chrome.tabs.sendMessage(tabId, { type: 'GET_SEARCH_BASE_URL' });
        if (!res || !res.baseUrl) {
          return { ok: false, error: 'Open a Zoopla search page (for-sale/property/...) then try again.' };
        }
        baseUrl = res.baseUrl;
        currentPage = res.currentPage || 1;
      } catch (e) {
        return { ok: false, error: 'Could not read page. Reload the Zoopla tab and try again.' };
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
    if (msg.type === 'START_BATCH_COLLECT') {
      const { tabId, postcodes, city } = msg;
      if (!tabId || !postcodes || postcodes.length === 0) return { ok: false, error: 'Missing tab or postcodes.' };
      const cfg = await getTab(PREFIX_CFG, tabId);
      if (!cfg || !cfg.locked) {
        return { ok: false, error: 'Save config (Max records) for this tab first.' };
      }
      const firstPc = postcodes[0].toLowerCase();
      const startUrl = `https://www.zoopla.co.uk/for-sale/property/${firstPc}/?q=${firstPc.toUpperCase()}&search_source=for-sale`;

      await setTab(PREFIX_BATCH, tabId, {
        postcodes,
        currentIndex: 0,
        accumulatedUrls: [],
        city: city || null
      });

      // Prepare collection state for the FIRST postcode
      const state = {
        baseUrl: `https://www.zoopla.co.uk/for-sale/property/${firstPc}/?q=${firstPc.toUpperCase()}&search_source=for-sale`,
        currentPage: 1,
        maxRecords: cfg.maxRecords || 500,
        collectedUrls: [],
        expectingUrl: null
      };
      await setTab(PREFIX_COLLECT, tabId, state);
      await setTab(PREFIX_CPROG, tabId, {
        status: 'collecting',
        currentPage: 1,
        linkCount: 0,
        maxRecords: `Batch (1/${postcodes.length})`
      });

      await chrome.tabs.update(tabId, { url: startUrl });
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
        return { ok: false, error: 'No link list in this tab. Collect links in this tab first.' };
      }
      const { queue, location: crawlLocation } = session;
      const urlsOnly = queue.map(u => typeof u === 'object' ? u.url : u);
      const existingSet = await fetchExistingUrlsFromBackend(urlsOnly);
      const toCrawl = existingSet.size > 0 ? queue.filter((u) => {
         const url = typeof u === 'object' ? u.url : u;
         return !existingSet.has(url);
      }) : queue;
      if (toCrawl.length === 0) {
        return { ok: false, error: 'All ' + queue.length + ' links already exist in database. No need to crawl again.' };
      }
      await setTab(PREFIX_CRAWL, tabId, { queue: toCrawl, index: 0, location: crawlLocation || '' });
      const firstItem = toCrawl[0];
      const firstUrl = typeof firstItem === 'object' ? firstItem.url : firstItem;
      await chrome.tabs.update(tabId, { url: firstUrl });
      return { ok: true, skipped: queue.length - toCrawl.length, total: toCrawl.length };
    }
    if (msg.type === 'PAGE_LOADED') {
      const tabId = sender.tab?.id;
      if (tabId == null) return null;
      const session = await getTab(PREFIX_CRAWL, tabId);
      if (!session || !session.queue || session.queue.length === 0) return null;
      const { queue, index: crawlIndex, location: crawlLocation } = session;
      const currentItem = queue[crawlIndex];
      const targetUrl = typeof currentItem === 'object' ? currentItem.url : currentItem;
      if (msg.url !== targetUrl) return null;
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const res = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_CURRENT_PAGE' });
        if (res && res.data) {
          // Tag with metadata if missing
          if (typeof currentItem === 'object') {
            if (currentItem.postcode && !res.data.postcode) {
              res.data.postcode = currentItem.postcode;
            }
            if (currentItem.city && (!res.data.city || res.data.city === '')) {
              res.data.city = currentItem.city;
            }
          }
          // Fallback to crawlLocation logic if metadata not found
          if (crawlLocation && typeof crawlLocation === 'object') {
            if (crawlLocation.postcode && !res.data.postcode) {
              res.data.postcode = crawlLocation.postcode;
            }
            if (crawlLocation.city && (!res.data.city || res.data.city === '')) {
              res.data.city = crawlLocation.city;
            }
          }
          await add(res.data);
          await maybeAutoPushAfterSave(tabId);
          await maybeAutoExportCsv(tabId);
        }
      } catch (e) {}
      const nextIndex = crawlIndex + 1;
      if (nextIndex < queue.length) {
        await setTab(PREFIX_CRAWL, tabId, { queue, index: nextIndex, location: crawlLocation || '' });
        const nextItem = queue[nextIndex];
        const nextUrl = typeof nextItem === 'object' ? nextItem.url : nextItem;
        await chrome.tabs.update(tabId, { url: nextUrl });
      } else {
        await pushRemainderToBackend(tabId);
      }
      return { ok: true };
    }
    if (msg.type === 'SEND_TO_BACKEND') {
      const { backendUrl } = await chrome.storage.sync.get('backendUrl');
      if (!backendUrl || !backendUrl.trim()) {
        return { ok: false, error: 'Backend URL not configured in Settings.' };
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

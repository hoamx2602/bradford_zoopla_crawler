(function () {
  const inputMaxRecords = document.getElementById('inputMaxRecords');
  const inputAutoPushEvery = document.getElementById('inputAutoPushEvery');
  const configUnlockedArea = document.getElementById('configUnlockedArea');
  const configLockedArea = document.getElementById('configLockedArea');
  const btnSaveConfig = document.getElementById('btnSaveConfig');
  const btnCollectMulti = document.getElementById('btnCollectMulti');
  const collectProgress = document.getElementById('collectProgress');
  const collectProgressText = document.getElementById('collectProgressText');
  const linksInfo = document.getElementById('linksInfo');
  const linksInfoNoQueue = document.getElementById('linksInfoNoQueue');
  const linksInfoHasQueue = document.getElementById('linksInfoHasQueue');
  const linksCount = document.getElementById('linksCount');
  const linksLocationSpan = document.getElementById('linksLocationSpan');
  const tabContextLabel = document.getElementById('tabContextLabel');
  const btnCrawlPages = document.getElementById('btnCrawlPages');
  const activeCrawlTabsList = document.getElementById('activeCrawlTabsList');
  const savedCount = document.getElementById('savedCount');
  const btnExportCsv = document.getElementById('btnExportCsv');
  const btnClearAll = document.getElementById('btnClearAll');
  const linkOptions = document.getElementById('linkOptions');
  const crawlCurrentPageSection = document.getElementById('crawlCurrentPageSection');
  const btnCrawlCurrentPage = document.getElementById('btnCrawlCurrentPage');
  const crawlCurrentPageStatus = document.getElementById('crawlCurrentPageStatus');
  const crawlCurrentPageDesc = document.getElementById('crawlCurrentPageDesc');

  linkOptions.href = chrome.runtime.getURL('options.html');

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  function isZooplaUrl(url) {
    return url && url.startsWith('https://www.zoopla.co.uk/');
  }

  function isDetailPage(url) {
    return /\/for-sale\/details\/\d+/.test(url || '');
  }

  function isSearchPage(url) {
    return /\/for-sale\/property\/[^/]+\/?/.test(url || '');
  }

  async function refreshSavedCount() {
    const count = await chrome.runtime.sendMessage({ type: 'GET_COUNT' });
    savedCount.textContent = count != null ? `Saved ${count} records (local).` : 'Failed to read local data.';
  }

  async function refreshConfigUI() {
    const tab = await getActiveTab();
    const tabId = tab?.id ?? null;
    const { crawlConfig, configLocked } = await chrome.runtime.sendMessage({ type: 'GET_CRAWL_CONFIG', tabId });
    if (configLocked && crawlConfig) {
      inputMaxRecords.value = crawlConfig.maxRecords || 500;
      inputAutoPushEvery.value = crawlConfig.autoPushEvery || 50;
      inputMaxRecords.disabled = true;
      inputAutoPushEvery.disabled = true;
      configUnlockedArea.classList.add('hidden');
      configLockedArea.classList.remove('hidden');
    } else {
      inputMaxRecords.value = crawlConfig?.maxRecords ?? 500;
      inputAutoPushEvery.value = crawlConfig?.autoPushEvery ?? 50;
      inputMaxRecords.disabled = false;
      inputAutoPushEvery.disabled = false;
      configUnlockedArea.classList.remove('hidden');
      configLockedArea.classList.add('hidden');
    }
  }

  async function refreshActiveCrawlTabs() {
    if (!activeCrawlTabsList) return;
    const { tabs } = await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_CRAWL_TABS' }) || {};
    if (!tabs || tabs.length === 0) {
      activeCrawlTabsList.innerHTML = '<p class="card-desc muted">No active crawling tabs.</p>';
      return;
    }
    activeCrawlTabsList.innerHTML = '';
    for (const t of tabs) {
      const label = t.location ? `${t.location} — ${t.currentIndex + 1}/${t.queueLength}` : `${t.currentIndex + 1}/${t.queueLength} links`;
      const title = t.title && t.title.trim() ? t.title.trim() : `Tab ${t.tabId}`;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'active-crawl-tab-item';
      el.dataset.tabId = String(t.tabId);
      el.dataset.windowId = String(t.windowId);
      el.innerHTML = `<span class="tab-title">${escapeHtml(title)}</span><span class="tab-meta">${escapeHtml(label)} · Click to switch</span>`;
      el.addEventListener('click', async () => {
        const id = parseInt(el.dataset.tabId, 10);
        const winId = parseInt(el.dataset.windowId, 10);
        try {
          await chrome.windows.update(winId, { focused: true });
          await chrome.tabs.update(id, { active: true });
          window.close();
        } catch (e) {}
      });
      activeCrawlTabsList.appendChild(el);
    }
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  async function refreshLinksInfo() {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    const state = await chrome.runtime.sendMessage({ type: 'GET_CRAWL_STATE_FOR_TAB', tabId: tab.id });
    if (state?.hasQueue && state.queueLength > 0) {
      linksCount.textContent = state.queueLength;
      linksLocationSpan.textContent = state.location ? ` (${state.location})` : '';
      if (linksInfoNoQueue) linksInfoNoQueue.classList.add('hidden');
      if (linksInfoHasQueue) linksInfoHasQueue.classList.remove('hidden');
    } else {
      linksLocationSpan.textContent = '';
      if (linksInfoNoQueue) linksInfoNoQueue.classList.remove('hidden');
      if (linksInfoHasQueue) linksInfoHasQueue.classList.add('hidden');
    }
    const cfg = await chrome.runtime.sendMessage({ type: 'GET_CRAWL_CONFIG', tabId: tab.id });
    if (cfg?.configLocked && cfg?.crawlConfig) {
      tabContextLabel.textContent = '— This tab has config';
    } else {
      tabContextLabel.textContent = '— This tab has no config';
    }
  }

  async function refreshCrawlCurrentPageSection() {
    const tab = await getActiveTab();
    if (!crawlCurrentPageSection || !btnCrawlCurrentPage) return;
    const onDetailPage = tab?.id && isZooplaUrl(tab.url) && isDetailPage(tab.url);
    if (onDetailPage) {
      if (crawlCurrentPageDesc) crawlCurrentPageDesc.textContent = "You're on a listing detail page. Click to save this page's data locally (and auto-push to backend if enabled).";
      btnCrawlCurrentPage.disabled = false;
      btnCrawlCurrentPage.style.display = '';
      if (crawlCurrentPageStatus) crawlCurrentPageStatus.textContent = '';
    } else {
      if (crawlCurrentPageDesc) crawlCurrentPageDesc.textContent = 'Open a Zoopla listing page (for-sale/details/...) in this tab to crawl this page.';
      btnCrawlCurrentPage.disabled = true;
      btnCrawlCurrentPage.style.display = '';
      if (crawlCurrentPageStatus) crawlCurrentPageStatus.textContent = '';
    }
  }

  async function refreshCollectionProgress() {
    const tab = await getActiveTab();
    const tabId = tab?.id ?? null;
    const progress = await chrome.runtime.sendMessage({ type: 'GET_COLLECTION_PROGRESS', tabId });
    if (!progress) {
      collectProgress.classList.add('hidden');
      await refreshLinksInfo();
      return;
    }
    collectProgress.classList.remove('hidden');
    if (progress.status === 'collecting') {
      collectProgressText.textContent = `Collecting... Page ${progress.currentPage || 1} · ${progress.linkCount || 0} / ${progress.maxRecords || '?'} links`;
    } else if (progress.status === 'done') {
      collectProgressText.textContent = `Done: ${progress.linkCount} links (${progress.pagesDone || progress.currentPage} pages).`;
      await refreshLinksInfo();
      await refreshActiveCrawlTabs();
    } else if (progress.status === 'error') {
      collectProgressText.textContent = 'Error: ' + (progress.error || '');
    }
  }

  btnSaveConfig.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    const maxRecords = Math.max(1, Math.min(5000, parseInt(inputMaxRecords.value, 10) || 500));
    const autoPushEvery = Math.max(1, Math.min(1000, parseInt(inputAutoPushEvery.value, 10) || 50));
    await chrome.runtime.sendMessage({
      type: 'SET_CRAWL_CONFIG_FOR_TAB',
      tabId: tab.id,
      maxRecords,
      autoPushEvery
    });
    await refreshConfigUI();
    await refreshLinksInfo();
  });

  btnCollectMulti.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab?.id || !isZooplaUrl(tab.url)) {
      alert('Open a Zoopla search page (e.g. for-sale/property/manchester/), then try again.');
      return;
    }
    btnCollectMulti.disabled = true;
    collectProgress.classList.remove('hidden');
    collectProgressText.textContent = 'Starting collection...';
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'START_MULTI_PAGE_COLLECT',
        tabId: tab.id
      });
      if (result && result.ok) {
        await refreshCollectionProgress();
      } else {
        collectProgressText.textContent = result?.error || 'Error';
        alert(result?.error || 'Error');
      }
    } catch (e) {
      collectProgressText.textContent = 'Error: ' + (e.message || '');
    }
    btnCollectMulti.disabled = false;
  });

  btnCrawlCurrentPage.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab?.id || !isZooplaUrl(tab.url) || !isDetailPage(tab.url)) {
      if (crawlCurrentPageStatus) crawlCurrentPageStatus.textContent = 'Open a Zoopla listing page (for-sale/details/...) then try again.';
      return;
    }
    btnCrawlCurrentPage.disabled = true;
    if (crawlCurrentPageStatus) crawlCurrentPageStatus.textContent = 'Extracting...';
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_CURRENT_PAGE' });
      if (!res?.data) {
        if (crawlCurrentPageStatus) crawlCurrentPageStatus.textContent = 'Could not read page data.';
        return;
      }
      const saveResult = await chrome.runtime.sendMessage({ type: 'SAVE_PROPERTY', data: res.data, tabId: tab.id });
      if (saveResult?.ok) {
        if (crawlCurrentPageStatus) crawlCurrentPageStatus.textContent = 'Page saved.';
        await refreshSavedCount();
      } else {
        if (crawlCurrentPageStatus) crawlCurrentPageStatus.textContent = 'Save failed.';
      }
    } catch (e) {
      if (crawlCurrentPageStatus) crawlCurrentPageStatus.textContent = 'Error: ' + (e.message || e);
    }
    btnCrawlCurrentPage.disabled = false;
  });

  btnCrawlPages.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    btnCrawlPages.disabled = true;
    btnCrawlPages.textContent = 'Checking backend...';
    try {
      const result = await chrome.runtime.sendMessage({ type: 'START_CRAWL_TAB', tabId: tab.id });
      if (result && result.ok) {
        if (result.skipped > 0) {
          btnCrawlPages.textContent = 'Crawling ' + result.total + ' links (skipped ' + result.skipped + ' existing)';
        } else {
          btnCrawlPages.textContent = 'Crawling (auto-push every X records)';
        }
        await refreshActiveCrawlTabs();
      } else {
        btnCrawlPages.textContent = 'Crawl pages';
        alert(result?.error || 'Error');
      }
    } catch (e) {
      btnCrawlPages.textContent = 'Crawl pages';
      alert('Error: ' + (e.message || ''));
    }
    btnCrawlPages.disabled = false;
  });

  btnExportCsv.addEventListener('click', async () => {
    try {
      const rows = await chrome.runtime.sendMessage({ type: 'GET_ALL' });
      if (!rows || rows.length === 0) {
        alert('No data to export yet.');
        return;
      }
      const csv = toCsv(rows);
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'zoopla_export_' + new Date().toISOString().slice(0, 10) + '.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('Export error: ' + (e.message || ''));
    }
  });

  btnClearAll.addEventListener('click', async () => {
    if (!confirm('This will clear all local data and config for ALL tabs. Continue?')) return;
    try {
      await chrome.runtime.sendMessage({ type: 'CLEAR_ALL' });
      await refreshConfigUI();
      await refreshSavedCount();
      await refreshLinksInfo();
      refreshActiveCrawlTabs();
      collectProgress.classList.add('hidden');
      inputMaxRecords.value = 500;
      inputAutoPushEvery.value = 50;
      inputMaxRecords.disabled = false;
      inputAutoPushEvery.disabled = false;
      if (tabContextLabel) tabContextLabel.textContent = '';
      if (linksLocationSpan) linksLocationSpan.textContent = '';
    } catch (e) {
      alert('Error: ' + (e.message || ''));
    }
  });

  function toCsv(rows) {
    const keys = ['url', 'city', 'price', 'address', 'property_type', 'bedrooms', 'bathrooms', 'living_rooms', 'area_sqft', 'description', 'epc_rating'];
    const header = keys.join(',');
    const escape = (v) => {
      if (v == null) return '';
      const s = String(v).replace(/"/g, '""');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s + '"' : s;
    };
    const lines = [header].concat(rows.map((r) => keys.map((k) => escape(r[k])).join(',')));
    return lines.join('\n');
  }

  refreshSavedCount();
  refreshConfigUI();
  refreshCrawlCurrentPageSection();
  refreshCollectionProgress();
  refreshLinksInfo();
  refreshActiveCrawlTabs();
})();

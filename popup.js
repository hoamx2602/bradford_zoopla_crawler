(function () {
  const pageStatus = document.getElementById('pageStatus');
  const currentPageActions = document.getElementById('currentPageActions');
  const btnExtractOne = document.getElementById('btnExtractOne');
  const inputMaxRecords = document.getElementById('inputMaxRecords');
  const inputAutoPushEvery = document.getElementById('inputAutoPushEvery');
  const configUnlockedArea = document.getElementById('configUnlockedArea');
  const configLockedArea = document.getElementById('configLockedArea');
  const btnSaveConfig = document.getElementById('btnSaveConfig');
  const btnCollectMulti = document.getElementById('btnCollectMulti');
  const collectProgress = document.getElementById('collectProgress');
  const collectProgressText = document.getElementById('collectProgressText');
  const linksInfo = document.getElementById('linksInfo');
  const linksCount = document.getElementById('linksCount');
  const linksLocationSpan = document.getElementById('linksLocationSpan');
  const tabContextLabel = document.getElementById('tabContextLabel');
  const btnCrawlPages = document.getElementById('btnCrawlPages');
  const savedCount = document.getElementById('savedCount');
  const btnExportCsv = document.getElementById('btnExportCsv');
  const btnClearAll = document.getElementById('btnClearAll');
  const linkOptions = document.getElementById('linkOptions');

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

  async function updatePageStatus() {
    const tab = await getActiveTab();
    if (!tab?.url || !isZooplaUrl(tab.url)) {
      pageStatus.textContent = 'Mở một trang Zoopla (zoopla.co.uk) để dùng extension.';
      currentPageActions.classList.add('hidden');
      return;
    }
    if (isDetailPage(tab.url)) {
      pageStatus.textContent = 'Trang chi tiết listing — có thể lưu listing này.';
      currentPageActions.classList.remove('hidden');
    } else if (isSearchPage(tab.url)) {
      pageStatus.textContent = 'Trang tìm kiếm — lưu config rồi thu thập link.';
      currentPageActions.classList.add('hidden');
    } else {
      pageStatus.textContent = 'Trang Zoopla — mở trang tìm kiếm hoặc trang chi tiết.';
      currentPageActions.classList.add('hidden');
    }
  }

  async function refreshSavedCount() {
    const count = await chrome.runtime.sendMessage({ type: 'GET_COUNT' });
    savedCount.textContent = count != null ? `Đã lưu ${count} bản ghi (local).` : 'Lỗi đọc dữ liệu.';
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

  async function refreshLinksInfo() {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    const state = await chrome.runtime.sendMessage({ type: 'GET_CRAWL_STATE_FOR_TAB', tabId: tab.id });
    if (state?.hasQueue && state.queueLength > 0) {
      linksCount.textContent = state.queueLength;
      linksLocationSpan.textContent = state.location ? ` (${state.location})` : '';
      linksInfo.classList.remove('hidden');
    } else {
      linksLocationSpan.textContent = '';
      linksInfo.classList.add('hidden');
    }
    const cfg = await chrome.runtime.sendMessage({ type: 'GET_CRAWL_CONFIG', tabId: tab.id });
    if (cfg?.configLocked && cfg?.crawlConfig) {
      tabContextLabel.textContent = '— Tab này đã có config';
    } else {
      tabContextLabel.textContent = '— Tab này chưa có config';
    }
  }

  async function refreshCollectionProgress() {
    const progress = await chrome.runtime.sendMessage({ type: 'GET_COLLECTION_PROGRESS' });
    if (!progress) {
      collectProgress.classList.add('hidden');
      await refreshLinksInfo();
      return;
    }
    collectProgress.classList.remove('hidden');
    if (progress.status === 'collecting') {
      collectProgressText.textContent = `Đang thu thập... Trang ${progress.currentPage || 1} · ${progress.linkCount || 0} / ${progress.maxRecords || '?'} link`;
    } else if (progress.status === 'done') {
      collectProgressText.textContent = `Xong: ${progress.linkCount} link (${progress.pagesDone || progress.currentPage} trang).`;
      await refreshLinksInfo();
    } else if (progress.status === 'error') {
      collectProgressText.textContent = 'Lỗi: ' + (progress.error || '');
    }
  }

  btnExtractOne.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab?.id || !isDetailPage(tab.url)) {
      alert('Mở trang chi tiết một listing trên Zoopla rồi thử lại.');
      return;
    }
    btnExtractOne.disabled = true;
    btnExtractOne.textContent = 'Đang lấy...';
    try {
      const result = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_CURRENT_PAGE' });
      if (result && result.data) {
        await chrome.runtime.sendMessage({ type: 'SAVE_PROPERTY', data: result.data, tabId: tab.id });
        await refreshSavedCount();
        btnExtractOne.textContent = 'Đã lưu!';
      } else {
        btnExtractOne.textContent = 'Lỗi hoặc chưa load xong trang';
      }
    } catch (e) {
      btnExtractOne.textContent = 'Lỗi: ' + (e.message || 'reload trang thử');
    }
    btnExtractOne.disabled = false;
  });

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
      alert('Mở trang tìm kiếm Zoopla (ví dụ for-sale/property/manchester/) rồi thử lại.');
      return;
    }
    btnCollectMulti.disabled = true;
    collectProgress.classList.remove('hidden');
    collectProgressText.textContent = 'Đang bắt đầu thu thập...';
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'START_MULTI_PAGE_COLLECT',
        tabId: tab.id
      });
      if (result && result.ok) {
        await refreshCollectionProgress();
      } else {
        collectProgressText.textContent = result?.error || 'Lỗi';
        alert(result?.error || 'Lỗi');
      }
    } catch (e) {
      collectProgressText.textContent = 'Lỗi: ' + (e.message || '');
    }
    btnCollectMulti.disabled = false;
  });

  btnCrawlPages.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    btnCrawlPages.disabled = true;
    btnCrawlPages.textContent = 'Đang kiểm tra backend...';
    try {
      const result = await chrome.runtime.sendMessage({ type: 'START_CRAWL_TAB', tabId: tab.id });
      if (result && result.ok) {
        if (result.skipped > 0) {
          btnCrawlPages.textContent = 'Crawl ' + result.total + ' link (đã bỏ ' + result.skipped + ' link có sẵn)';
        } else {
          btnCrawlPages.textContent = 'Crawl đang chạy (tự đẩy backend mỗi X bản ghi)';
        }
      } else {
        btnCrawlPages.textContent = 'Crawl từng trang';
        alert(result?.error || 'Lỗi');
      }
    } catch (e) {
      btnCrawlPages.textContent = 'Crawl từng trang';
      alert('Lỗi: ' + (e.message || ''));
    }
    btnCrawlPages.disabled = false;
  });

  btnExportCsv.addEventListener('click', async () => {
    try {
      const rows = await chrome.runtime.sendMessage({ type: 'GET_ALL' });
      if (!rows || rows.length === 0) {
        alert('Chưa có dữ liệu để export.');
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
      alert('Lỗi export: ' + (e.message || ''));
    }
  });

  btnClearAll.addEventListener('click', async () => {
    if (!confirm('Xóa toàn bộ dữ liệu local và config của mọi tab, mở khóa để chỉnh lại. Tiếp tục?')) return;
    try {
      await chrome.runtime.sendMessage({ type: 'CLEAR_ALL' });
      await refreshConfigUI();
      await refreshSavedCount();
      await refreshLinksInfo();
      linksInfo.classList.add('hidden');
      collectProgress.classList.add('hidden');
      inputMaxRecords.value = 500;
      inputAutoPushEvery.value = 50;
      inputMaxRecords.disabled = false;
      inputAutoPushEvery.disabled = false;
      if (tabContextLabel) tabContextLabel.textContent = '';
      if (linksLocationSpan) linksLocationSpan.textContent = '';
    } catch (e) {
      alert('Lỗi: ' + (e.message || ''));
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

  updatePageStatus();
  refreshSavedCount();
  refreshConfigUI();
  refreshCollectionProgress();
  refreshLinksInfo();
})();

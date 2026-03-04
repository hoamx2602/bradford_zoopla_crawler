(function () {
  const pageStatus = document.getElementById('pageStatus');
  const currentPageActions = document.getElementById('currentPageActions');
  const btnExtractOne = document.getElementById('btnExtractOne');
  const inputMaxPages = document.getElementById('inputMaxPages');
  const inputMaxRecords = document.getElementById('inputMaxRecords');
  const btnCollectMulti = document.getElementById('btnCollectMulti');
  const collectProgress = document.getElementById('collectProgress');
  const collectProgressText = document.getElementById('collectProgressText');
  const linksInfo = document.getElementById('linksInfo');
  const linksCount = document.getElementById('linksCount');
  const btnCrawlPages = document.getElementById('btnCrawlPages');
  const savedCount = document.getElementById('savedCount');
  const btnExportCsv = document.getElementById('btnExportCsv');
  const btnSendBackend = document.getElementById('btnSendBackend');
  const backendStatus = document.getElementById('backendStatus');
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
      pageStatus.textContent = 'Trang tìm kiếm — cấu hình số trang/bản ghi rồi thu thập link.';
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

  async function refreshCollectionProgress() {
    const progress = await chrome.runtime.sendMessage({ type: 'GET_COLLECTION_PROGRESS' });
    if (!progress) {
      collectProgress.classList.add('hidden');
      return;
    }
    collectProgress.classList.remove('hidden');
    if (progress.status === 'collecting') {
      collectProgressText.textContent = `Đang thu thập... Trang ${progress.currentPage}/${progress.maxPages} · ${progress.linkCount} link`;
    } else if (progress.status === 'done') {
      collectProgressText.textContent = `Xong: ${progress.linkCount} link (${progress.pagesDone || progress.currentPage} trang).`;
      linksCount.textContent = progress.linkCount;
      linksInfo.classList.remove('hidden');
    } else if (progress.status === 'error') {
      collectProgressText.textContent = 'Lỗi: ' + (progress.error || '');
    }
  }

  function setBackendStatus(text, isError) {
    backendStatus.classList.remove('hidden', 'success', 'error');
    backendStatus.textContent = text;
    backendStatus.classList.add(isError ? 'error' : 'success');
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
        await chrome.runtime.sendMessage({ type: 'SAVE_PROPERTY', data: result.data });
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

  btnCollectMulti.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab?.id || !isZooplaUrl(tab.url)) {
      alert('Mở trang tìm kiếm Zoopla (ví dụ for-sale/property/manchester/) rồi thử lại.');
      return;
    }
    const maxPages = Math.max(1, Math.min(100, parseInt(inputMaxPages.value, 10) || 5));
    const maxRecords = Math.max(1, Math.min(5000, parseInt(inputMaxRecords.value, 10) || 500));
    btnCollectMulti.disabled = true;
    collectProgress.classList.remove('hidden');
    collectProgressText.textContent = 'Đang bắt đầu thu thập...';
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'START_MULTI_PAGE_COLLECT',
        maxPages,
        maxRecords,
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
    btnCrawlPages.textContent = 'Đang crawl...';
    try {
      await chrome.runtime.sendMessage({ type: 'START_CRAWL_TAB', tabId: tab.id });
      btnCrawlPages.textContent = 'Crawl đang chạy (mở popup lại để xem)';
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

  btnSendBackend.addEventListener('click', async () => {
    backendStatus.classList.remove('hidden');
    backendStatus.textContent = 'Đang gửi...';
    try {
      const result = await chrome.runtime.sendMessage({ type: 'SEND_TO_BACKEND' });
      if (result && result.ok) {
        setBackendStatus('Đã gửi ' + (result.sent || 0) + ' bản ghi lên backend.', false);
      } else {
        setBackendStatus(result?.error || 'Chưa cấu hình Backend URL (xem Cài đặt).', true);
      }
    } catch (e) {
      setBackendStatus('Lỗi: ' + (e.message || ''), true);
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
  refreshCollectionProgress();

  chrome.storage.local.get('crawlQueue').then((o) => {
    const queue = o.crawlQueue || [];
    if (queue.length > 0) {
      linksCount.textContent = queue.length;
      linksInfo.classList.remove('hidden');
    }
  });
})();

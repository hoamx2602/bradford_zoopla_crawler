(function () {
  const pageStatus = document.getElementById('pageStatus');
  const currentPageActions = document.getElementById('currentPageActions');
  const btnExtractOne = document.getElementById('btnExtractOne');
  const btnGetLinks = document.getElementById('btnGetLinks');
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
      pageStatus.textContent = 'Trang tìm kiếm — dùng "Lấy danh sách link" rồi "Crawl từng trang".';
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

  btnGetLinks.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab?.id || !isZooplaUrl(tab.url)) {
      alert('Mở trang tìm kiếm Zoopla (ví dụ for-sale/property/manchester/) rồi thử lại.');
      return;
    }
    btnGetLinks.disabled = true;
    btnGetLinks.textContent = 'Đang lấy...';
    try {
      const result = await chrome.tabs.sendMessage(tab.id, { type: 'GET_LISTING_LINKS' });
      if (result && result.urls && result.urls.length > 0) {
        await chrome.runtime.sendMessage({ type: 'SET_QUEUE', urls: result.urls });
        linksCount.textContent = result.urls.length;
        linksInfo.classList.remove('hidden');
        btnGetLinks.textContent = 'Lấy danh sách link';
      } else {
        alert('Không tìm thấy link listing. Đảm bảo đang ở trang kết quả tìm kiếm Zoopla.');
        btnGetLinks.textContent = 'Lấy danh sách link';
      }
    } catch (e) {
      alert('Lỗi: ' + (e.message || 'reload trang thử'));
      btnGetLinks.textContent = 'Lấy danh sách link';
    }
    btnGetLinks.disabled = false;
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
        backendStatus.textContent = 'Đã gửi ' + (result.sent || 0) + ' bản ghi lên backend.';
      } else {
        backendStatus.textContent = result?.error || 'Chưa cấu hình Backend URL (xem Cài đặt).';
      }
    } catch (e) {
      backendStatus.textContent = 'Lỗi: ' + (e.message || '');
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
})();

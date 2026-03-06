(function () {
  const backendUrl = document.getElementById('backendUrl');
  const saveBtn = document.getElementById('save');
  const status = document.getElementById('status');
  const autoExportEvery = document.getElementById('autoExportEvery');
  const saveExportBtn = document.getElementById('saveExport');
  const statusExport = document.getElementById('statusExport');

  chrome.storage.sync.get(['backendUrl', 'autoExportEvery'], (data) => {
    if (data.backendUrl) backendUrl.value = data.backendUrl;
    if (data.autoExportEvery != null) autoExportEvery.value = Math.max(1, Math.min(1000, data.autoExportEvery));
    else autoExportEvery.value = 1000;
  });

  saveBtn.addEventListener('click', () => {
    const url = (backendUrl.value || '').trim();
    chrome.storage.sync.set({ backendUrl: url || '' }, () => {
      status.textContent = url ? 'Saved.' : 'Cleared.';
      status.className = 'status ' + (url ? 'ok' : 'warn');
    });
  });

  saveExportBtn.addEventListener('click', () => {
    const n = Math.max(1, Math.min(1000, parseInt(autoExportEvery.value, 10) || 1000));
    chrome.storage.sync.set({ autoExportEvery: n }, () => {
      statusExport.textContent = 'Saved. Auto-export every ' + n + ' records.';
      statusExport.className = 'status ok';
    });
  });
})();

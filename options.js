(function () {
  const backendUrl = document.getElementById('backendUrl');
  const saveBtn = document.getElementById('save');
  const status = document.getElementById('status');

  chrome.storage.sync.get('backendUrl', (data) => {
    if (data.backendUrl) backendUrl.value = data.backendUrl;
  });

  saveBtn.addEventListener('click', () => {
    const url = (backendUrl.value || '').trim();
    chrome.storage.sync.set({ backendUrl: url || '' }, () => {
      status.textContent = url ? 'Saved.' : 'Cleared.';
      status.className = 'status ' + (url ? 'ok' : 'warn');
    });
  });
})();

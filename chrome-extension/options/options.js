const apiKeyInput = document.getElementById('apiKey');
const showKeyCheckbox = document.getElementById('showKey');
const saveBtn = document.getElementById('saveBtn');
const statusEl = document.getElementById('status');

// Prefill if a key already exists
chrome.storage.local.get('apiKey', ({ apiKey }) => {
  if (apiKey) apiKeyInput.value = apiKey;
});

// Toggle key visibility
showKeyCheckbox.addEventListener('change', () => {
  apiKeyInput.type = showKeyCheckbox.checked ? 'text' : 'password';
});

// Save key
saveBtn.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  statusEl.className = '';
  statusEl.textContent = '';

  if (!key) {
    statusEl.className = 'error';
    statusEl.textContent = 'Please enter an API key.';
    return;
  }

  if (!key.startsWith('sk-ant-')) {
    statusEl.className = 'error';
    statusEl.textContent = 'Key should start with "sk-ant-". Double-check and try again.';
    return;
  }

  chrome.storage.local.set({ apiKey: key }, () => {
    statusEl.textContent = 'Key saved!';
    setTimeout(() => { statusEl.textContent = ''; }, 2500);
  });
});

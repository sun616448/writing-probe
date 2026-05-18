document.getElementById('doneBtn').addEventListener('click', () => {
  chrome.storage.local.set({ onboardingDone: true }, () => window.close());
});

document.getElementById('openDocsBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://docs.google.com' });
});

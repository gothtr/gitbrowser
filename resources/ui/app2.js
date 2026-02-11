// === Navigation ===
function navigateInTab(tabId, input) {
  if (!input || !input.trim()) return;
  input = input.trim();
  let url;
  if (input === 'about:settings' || input === 'settings') {
    url = 'about:settings';
  } else if (isWebUrl(input)) {
    url = input.includes('://') ? input : 'https://' + input;
  } else {
    url = 'https://www.google.com/search?q=' + encodeURIComponent(input);
  }
  const oldPage = document.getElementById('page-' + tabId);
  if (oldPage) oldPage.remove();
  delete state.tabPages[tabId];
  state.tabPages[tabId] = {
    type: isInternalUrl(url) ? getInternalType(url) : 'web',
    url: url
  };
  ipcSend('navigate', { url: url, tabId: tabId });
}

function isWebUrl(s) {
  return s.includes('://') || s.startsWith('about:') ||
    (/^[\w][\w.-]*\.[a-z]{2,}(\/.*)?$/i.test(s) && !s.includes(' '));
}
function isInternalUrl(url) {
  return !url || url === 'about:newtab' || url === 'about:settings';
}
function getInternalType(url) {
  if (url === 'about:settings') return 'settings';
  return 'newtab';
}
function getDomain(url) {
  if (!url || url.startsWith('about:')) return '';
  try { return new URL(url).hostname.replace('www.', ''); }
  catch(e) { return ''; }
}
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

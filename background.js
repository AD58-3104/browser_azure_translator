// ショートカット・ボタン・バッジ・設定の管理を担当。
// 翻訳 API の呼び出しは、Service Worker の寿命制限を受けない offscreen.js で行う。
const DEFAULTS = {
  engine: 'azure',               // 'azure' | 'ollama'
  apiKey: '', region: '',
  ollamaUrl: 'http://localhost:11434', ollamaModel: 'translategemma:4b',
  ollamaModelHQ: 'translategemma:12b', // 段落単位の再翻訳用
  target: 'ja', hover: true,
};

const getSettings = () => chrome.storage.local.get(DEFAULTS);

chrome.action.onClicked.addListener((tab) => toggleTab(tab));
chrome.commands.onCommand.addListener((cmd, tab) => {
  if (cmd === 'toggle-translation') toggleTab(tab);
  // 翻訳済みのページでだけ動く（未翻訳のページには何もしない）
  if (cmd === 'retranslate-hq' && tab?.id != null) chrome.tabs.sendMessage(tab.id, { type: 'retranslate' }).catch(() => {});
});

async function toggleTab(tab) {
  if (!tab || tab.id == null) return;
  try {
    await ensureOffscreen();
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    const { target, hover, engine } = await getSettings();
    const state = await chrome.tabs.sendMessage(tab.id, { type: 'toggle', target, hover, engine });
    setBadge(tab.id, state);
  } catch (e) {
    // edge:// や拡張機能ストアなど、スクリプトを挿入できないページ
    console.warn('toggle failed:', e);
    setBadge(tab.id, 'error');
  }
}

let creating = null;
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  creating ??= chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DOM_PARSER'],
    justification: 'Run long translation requests and process translated HTML fragments outside the service worker.',
  }).finally(() => { creating = null; });
  await creating;
}

function setBadge(tabId, state) {
  const map = {
    translated: { text: '訳', color: '#2563eb' },
    original: { text: '原', color: '#6b7280' },
    error: { text: '!', color: '#dc2626' },
  };
  const b = map[state] || { text: '', color: '#6b7280' };
  chrome.action.setBadgeText({ tabId, text: b.text });
  chrome.action.setBadgeBackgroundColor({ tabId, color: b.color });
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') chrome.action.setBadgeText({ tabId, text: '' });
});

const isOffscreen = (sender) => !sender.tab && sender.url === chrome.runtime.getURL('offscreen.html');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'ensureOffscreen':
      ensureOffscreen().then(
        () => sendResponse(true),
        (e) => { console.warn(e); sendResponse(false); }
      );
      return true;
    case 'getSettings':
      if (!isOffscreen(sender)) return; // APIキーは offscreen にだけ渡す
      getSettings().then(sendResponse);
      return true;
    case 'addUsage':
      if (isOffscreen(sender)) addUsage(msg.n);
      return;
    case 'state':
      if (sender.tab) setBadge(sender.tab.id, msg.state);
      return;
    case 'getUsage':
      getUsage().then(sendResponse);
      return true;
  }
});

// 無料枠の目安として、Azure への月ごとの送信文字数を記録
const monthKey = () => new Date().toISOString().slice(0, 7);
async function addUsage(n) {
  const { usage = {} } = await chrome.storage.local.get('usage');
  const k = monthKey();
  usage[k] = (usage[k] || 0) + n;
  await chrome.storage.local.set({ usage });
}
async function getUsage() {
  const { usage = {} } = await chrome.storage.local.get('usage');
  return { month: monthKey(), chars: usage[monthKey()] || 0 };
}

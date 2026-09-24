// 翻訳APIの呼び出しとタブ操作を担当。APIキーはここでだけ使う。
const ENDPOINT = 'https://api.cognitive.microsofttranslator.com/translate';
const DEFAULTS = { apiKey: '', region: '', target: 'ja', hover: true };

const getSettings = () => chrome.storage.local.get(DEFAULTS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

chrome.action.onClicked.addListener((tab) => toggleTab(tab));
chrome.commands.onCommand.addListener((cmd, tab) => {
  if (cmd === 'toggle-translation') toggleTab(tab);
});

async function toggleTab(tab) {
  if (!tab || tab.id == null) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    const { target, hover } = await getSettings();
    const state = await chrome.tabs.sendMessage(tab.id, { type: 'toggle', target, hover });
    setBadge(tab.id, state);
  } catch (e) {
    // edge:// や拡張機能ストアなど、スクリプトを挿入できないページ
    console.warn('toggle failed:', e);
    setBadge(tab.id, 'error');
  }
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'translate') {
    translate(msg.texts).then(
      (translations) => sendResponse({ ok: true, translations }),
      (e) => sendResponse({ ok: false, error: String(e.message || e) })
    );
    return true; // 非同期で応答
  }
  if (msg.type === 'state' && sender.tab) setBadge(sender.tab.id, msg.state);
  if (msg.type === 'getUsage') {
    getUsage().then(sendResponse);
    return true;
  }
});

async function translate(texts) {
  const { apiKey, region, target } = await getSettings();
  if (!apiKey) throw new Error('NO_KEY');
  const url = `${ENDPOINT}?api-version=3.0&textType=html&to=${encodeURIComponent(target)}`;
  const headers = { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': apiKey };
  if (region) headers['Ocp-Apim-Subscription-Region'] = region;
  const body = JSON.stringify(texts.map((t) => ({ Text: t })));

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: 'POST', headers, body });
    if (res.status === 429 && attempt < 4) {
      const wait = Number(res.headers.get('Retry-After')) || 2 ** attempt;
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error?.message || ''; } catch {}
      throw new Error(`HTTP ${res.status}${detail ? ': ' + detail : ''}`);
    }
    const data = await res.json();
    await addUsage(texts.reduce((n, t) => n + t.length, 0));
    return data.map((d) => d.translations?.[0]?.text ?? '');
  }
}

// 無料枠の目安として、月ごとの送信文字数を記録
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

// 翻訳エンジンの呼び出しとタブ操作を担当。APIキーはここでだけ使う。
const AZURE_ENDPOINT = 'https://api.cognitive.microsofttranslator.com/translate';
const DEFAULTS = {
  engine: 'azure',               // 'azure' | 'ollama'
  apiKey: '', region: '',
  ollamaUrl: 'http://localhost:11434', ollamaModel: 'translategemma:4b',
  target: 'ja', hover: true,
};
const LANG_NAMES = { ja: 'Japanese', en: 'English', 'zh-Hans': 'Simplified Chinese', 'zh-Hant': 'Traditional Chinese', ko: 'Korean' };

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
    const { target, hover, engine } = await getSettings();
    const state = await chrome.tabs.sendMessage(tab.id, { type: 'toggle', target, hover, engine });
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

// texts は content.js が作った HTML 断片（& < > はエスケープ済み、インライン要素は <span id="kN">）
async function translate(texts) {
  const s = await getSettings();
  return s.engine === 'ollama' ? translateOllama(texts, s) : translateAzure(texts, s);
}

// ---------- Azure Translator ----------
async function translateAzure(texts, { apiKey, region, target }) {
  if (!apiKey) throw new Error('NO_KEY');
  const url = `${AZURE_ENDPOINT}?api-version=3.0&textType=html&to=${encodeURIComponent(target)}`;
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

// ---------- Ollama（ローカル） ----------
const unescapeHtml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const stripTags = (s) => s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '');
const tagIds = (s) => (s.match(/id="k\d+"/g) || []).sort().join(',');

function cleanOutput(s) {
  return s
    .replace(/<think>[\s\S]*?<\/think>/g, '')          // 推論過程を出すモデル対策
    .replace(/^\s*```[a-z]*\n?|\n?```\s*$/g, '')      // コードブロックで囲まれた場合
    .trim();
}

async function ollamaChat(prompt, { ollamaUrl, ollamaModel }) {
  let res;
  try {
    res = await fetch(`${ollamaUrl.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        keep_alive: '15m',
        options: { temperature: 0 },
      }),
    });
  } catch {
    throw new Error('Ollama に接続できません。Ollama が起動しているか、URL を確認してください。');
  }
  if (res.status === 403) throw new Error('Ollama に拒否されました（403）。環境変数 OLLAMA_ORIGINS を設定して Ollama を再起動してください。');
  if (res.status === 404) throw new Error(`モデル「${ollamaModel}」が見つかりません。ollama pull ${ollamaModel} を実行してください。`);
  if (!res.ok) throw new Error(`Ollama: HTTP ${res.status}`);
  const data = await res.json();
  return cleanOutput(data.message?.content ?? '');
}

async function translateOllama(texts, s) {
  if (!s.ollamaModel) throw new Error('モデル名が未設定です。');
  const lang = LANG_NAMES[s.target] || s.target;
  const out = [];
  for (const html of texts) {
    const plain = unescapeHtml(stripTags(html));
    if (html.includes('<span')) {
      // タグ付きで翻訳し、タグが崩れていたらテキストだけで訳し直す
      const prompt = `Translate the following HTML fragment into ${lang}. Output only the translated fragment, without any explanation.
Keep every <span id="..."> tag with its exact attributes, and put each one around the words that correspond to its original content. Keep <br> tags. Do not translate text inside tags that have class="notranslate".

${html}`;
      const r = await ollamaChat(prompt, s);
      if (tagIds(r) === tagIds(html)) { out.push(r); continue; }
    }
    const prompt = `Translate the following text into ${lang}. Output only the translation, without any explanation.

${plain}`;
    out.push(escapeHtml(await ollamaChat(prompt, s)));
  }
  return out;
}

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

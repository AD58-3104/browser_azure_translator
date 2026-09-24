// 翻訳 API の呼び出しを担当する offscreen document。
// Service Worker は「fetch の応答が 30 秒以上来ない」「30 秒間イベントがない」と
// 強制終了されるため、時間のかかる推論や 429 の待機はこちらで行う。
const AZURE_ENDPOINT = 'https://api.cognitive.microsofttranslator.com/translate';
const LANG_NAMES = { ja: 'Japanese', en: 'English', 'zh-Hans': 'Simplified Chinese', 'zh-Hant': 'Traditional Chinese', ko: 'Korean' };
const AZURE_TIMEOUT_MS = 60_000;
const OLLAMA_TIMEOUT_MS = 300_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 設定の取得不能・キー誤りなど、再試行しても直らないエラー
class FatalError extends Error {}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.to !== 'offscreen') return;
  if (msg.type !== 'translate' && msg.type !== 'translateHQ') return;
  handle(msg).then(
    (translations) => sendResponse({ ok: true, translations }),
    (e) => sendResponse({ ok: false, fatal: e instanceof FatalError, error: String(e.message || e) })
  );
  return true;
});

async function handle(msg) {
  const s = await chrome.runtime.sendMessage({ type: 'getSettings' });
  if (!s) throw new Error('設定を読み込めませんでした。');
  if (msg.type === 'translateHQ') {
    if (!s.ollamaModelHQ) throw new FatalError('再翻訳用のモデルが未設定です。');
    return translateOllama(msg.texts, { ...s, ollamaModel: s.ollamaModelHQ });
  }
  return s.engine === 'ollama' ? translateOllama(msg.texts, s) : translateAzure(msg.texts, s);
}

async function fetchWithTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`応答が ${ms / 1000} 秒以内に返りませんでした。`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Azure Translator ----------
async function translateAzure(texts, { apiKey, region, target }) {
  if (!apiKey) throw new FatalError('NO_KEY');
  const url = `${AZURE_ENDPOINT}?api-version=3.0&textType=html&to=${encodeURIComponent(target)}`;
  const headers = { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': apiKey };
  if (region) headers['Ocp-Apim-Subscription-Region'] = region;
  const body = JSON.stringify(texts.map((t) => ({ Text: t })));

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchWithTimeout(url, { method: 'POST', headers, body }, AZURE_TIMEOUT_MS);
    } catch (e) {
      if (attempt < 3) { await sleep(2000 * 2 ** attempt); continue; } // 一時的な通信エラー
      throw e;
    }
    // 429（レート制限）と 5xx は待ってから再試行
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      const wait = Number(res.headers.get('Retry-After')) || Math.min(60, 2 ** (attempt + 1));
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error?.message || ''; } catch {}
      const msg = `HTTP ${res.status}${detail ? ': ' + detail : ''}`;
      throw (res.status === 401 || res.status === 403) ? new FatalError(msg) : new Error(msg);
    }
    const data = await res.json();
    chrome.runtime.sendMessage({ type: 'addUsage', n: texts.reduce((n, t) => n + t.length, 0) });
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
    res = await fetchWithTimeout(`${ollamaUrl.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        keep_alive: '15m',
        // 長い段落でもプロンプトが切り捨てられないよう、コンテキスト長を広げる
        options: { temperature: 0, num_ctx: 8192 },
      }),
    }, OLLAMA_TIMEOUT_MS);
  } catch (e) {
    if (/秒以内/.test(e.message)) throw e;
    throw new FatalError('Ollama に接続できません。Ollama が起動しているか、URL を確認してください。');
  }
  if (res.status === 403) throw new FatalError('Ollama に拒否されました（403）。環境変数 OLLAMA_ORIGINS を設定して Ollama を再起動してください。');
  if (res.status === 404) throw new FatalError(`モデル「${ollamaModel}」が見つかりません。ollama pull ${ollamaModel} を実行してください。`);
  if (!res.ok) throw new Error(`Ollama: HTTP ${res.status}`);
  const data = await res.json();
  return cleanOutput(data.message?.content ?? '');
}

async function translateOllama(texts, s) {
  if (!s.ollamaModel) throw new FatalError('モデル名が未設定です。');
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

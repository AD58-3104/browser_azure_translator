// 翻訳エンジン（Azure / Ollama）の呼び出し本体。
// offscreen.js と background.js（offscreen が使えない環境向けの予備経路）の両方から読み込む。
const AZURE_ENDPOINT = 'https://api.cognitive.microsofttranslator.com/translate';
const LANG_NAMES = { ja: 'Japanese', en: 'English', 'zh-Hans': 'Simplified Chinese', 'zh-Hant': 'Traditional Chinese', ko: 'Korean' };
const AZURE_TIMEOUT_MS = 60_000;
const OLLAMA_TIMEOUT_MS = 280_000; // Service Worker の 1 イベント 5 分制限より短く

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 設定の誤りなど、再試行しても直らないエラー
class FatalError extends Error {}

// msg: { type: 'translate' | 'translateHQ' | 'translateLight', texts, vary }
// s: 設定, onUsage: Azure の送信文字数を記録する関数
// vary: 同じモデルで訳し直すとき true。temperature 0 だと毎回同じ訳になるため、少し揺らす
async function runTranslation(msg, s, onUsage) {
  const temperature = msg.vary ? 0.7 : 0;
  if (msg.type === 'translateHQ') {
    if (!s.ollamaModelHQ) throw new FatalError('再翻訳用の高品質モデルが未設定です。');
    return translateOllama(msg.texts, { ...s, ollamaModel: s.ollamaModelHQ, temperature });
  }
  if (msg.type === 'translateLight') {
    if (!s.ollamaModel) throw new FatalError('通常の翻訳に使うモデルが未設定です。');
    return translateOllama(msg.texts, { ...s, temperature });
  }
  if (s.engine === 'ollama') return translateOllama(msg.texts, s);
  if (s.engine === 'ollamaHQ') {
    if (!s.ollamaModelHQ) throw new FatalError('高品質モデルが未設定です。');
    return translateOllama(msg.texts, { ...s, ollamaModel: s.ollamaModelHQ });
  }
  return translateAzure(msg.texts, s, onUsage);
}

// 結果を { ok, translations } / { ok: false, fatal, error } の形にそろえる
async function runTranslationSafe(msg, s, onUsage) {
  try {
    return { ok: true, translations: await runTranslation(msg, s, onUsage) };
  } catch (e) {
    return { ok: false, fatal: e instanceof FatalError, error: String(e.message || e) };
  }
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
async function translateAzure(texts, { apiKey, region, target }, onUsage) {
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
    onUsage?.(texts.reduce((n, t) => n + t.length, 0));
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

async function ollamaChat(prompt, { ollamaUrl, ollamaModel, ollamaNumCtx, temperature = 0 }) {
  // 生成の途中で止まった場合にも備え、読み終わるまでを含めてタイムアウトを掛ける
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OLLAMA_TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(`${ollamaUrl.replace(/\/+$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: ollamaModel,
          messages: [{ role: 'user', content: prompt }],
          stream: true, // 生成しながら少しずつ受け取る（応答待ちで打ち切られにくくする）
          keep_alive: '15m',
          // コンテキスト長は、指定があるときだけ送る（未指定なら Ollama 側の既定値に従う）。
          // 値が他のクライアントと食い違うと、そのたびにモデルが読み込み直されて遅くなる
          options: { temperature, ...(Number(ollamaNumCtx) > 0 ? { num_ctx: Number(ollamaNumCtx) } : {}) },
        }),
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new FatalError('Ollama に接続できません。Ollama が起動しているか、URL を確認してください。');
    }
    if (res.status === 403) throw new FatalError('Ollama に拒否されました（403）。環境変数 OLLAMA_ORIGINS を設定して Ollama を再起動してください。');
    if (res.status === 404) throw new FatalError(`モデル「${ollamaModel}」が見つかりません。ollama pull ${ollamaModel} を実行してください。`);
    if (!res.ok) throw new Error(`Ollama: HTTP ${res.status}`);

    // 改行区切りの JSON（NDJSON）を順に読み、生成されたテキストをつなげる
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', content = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const j = JSON.parse(line);
        if (j.error) throw new Error(`Ollama: ${j.error}`);
        content += j.message?.content ?? '';
      }
    }
    return cleanOutput(content);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Ollama の応答が ${OLLAMA_TIMEOUT_MS / 1000} 秒以内に終わりませんでした。`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
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

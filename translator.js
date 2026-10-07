// 翻訳エンジン（Azure / Ollama）の呼び出し本体。
// offscreen.js と background.js（offscreen が使えない環境向けの予備経路）の両方から読み込む。
const AZURE_ENDPOINT = 'https://api.cognitive.microsofttranslator.com/translate';
const LANG_NAMES = {
  ja: 'Japanese', en: 'English', zh: 'Chinese', 'zh-Hans': 'Simplified Chinese', 'zh-CN': 'Simplified Chinese',
  'zh-Hant': 'Traditional Chinese', 'zh-TW': 'Traditional Chinese', ko: 'Korean', fr: 'French', de: 'German',
  es: 'Spanish', it: 'Italian', pt: 'Portuguese', ru: 'Russian', ar: 'Arabic', hi: 'Hindi', vi: 'Vietnamese',
  th: 'Thai', id: 'Indonesian', nl: 'Dutch', pl: 'Polish', tr: 'Turkish', uk: 'Ukrainian', sv: 'Swedish', cs: 'Czech',
};
const langName = (code) => LANG_NAMES[code] || LANG_NAMES[String(code).split('-')[0]] || code;
const baseLang = (code) => String(code || '').split('-')[0].toLowerCase();
const AZURE_TIMEOUT_MS = 60_000;
const OLLAMA_TIMEOUT_MS = 280_000; // Service Worker の 1 イベント 5 分制限より短く

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 設定の誤りなど、再試行しても直らないエラー
class FatalError extends Error {}

// msg: { type: 'translate' | 'translateHQ' | 'translateLight', texts, srcLangs, vary }
// srcLangs: 各テキストの原文の言語コード（content.js が推定。不明なら null）
// s: 設定, onUsage: Azure の送信文字数を記録する関数
// vary: 同じモデルで訳し直すとき true。temperature 0 だと毎回同じ訳になるため、少し揺らす
async function runTranslation(msg, s, onUsage) {
  const temperature = msg.vary ? 0.4 : 0;
  const src = msg.srcLangs || [];
  if (msg.type === 'translateHQ') {
    if (!s.ollamaModelHQ) throw new FatalError('再翻訳用の高品質モデルが未設定です。');
    return translateOllama(msg.texts, { ...s, ollamaModel: s.ollamaModelHQ, temperature }, src);
  }
  if (msg.type === 'translateLight') {
    if (!s.ollamaModel) throw new FatalError('通常の翻訳に使うモデルが未設定です。');
    return translateOllama(msg.texts, { ...s, temperature }, src);
  }
  if (s.engine === 'ollama') return translateOllama(msg.texts, s, src);
  if (s.engine === 'ollamaHQ') {
    if (!s.ollamaModelHQ) throw new FatalError('高品質モデルが未設定です。');
    return translateOllama(msg.texts, { ...s, ollamaModel: s.ollamaModelHQ }, src);
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
// そのまま残す要素（数式・コード・画像など）が、訳文に 1 つずつ残っているか
const opaqueIds = (s) => s.match(/id="k\d+"(?= class="notranslate")/g) || [];
const keepsOpaque = (r, html) => opaqueIds(html).every((id) => r.split(id).length === 2);

function cleanOutput(s) {
  return s
    .replace(/<think>[\s\S]*?<\/think>/g, '')          // 推論過程を出すモデル対策
    .replace(/^\s*```[a-z]*\n?|\n?```\s*$/g, '')      // コードブロックで囲まれた場合
    .trim();
}

// 入力の長さから、出力トークン数の上限を決める。
// 上限がないと、モデルが同じ語句を繰り返し続けたときにコンテキストが埋まるまで生成が止まらない
const maxTokensFor = (text) => Math.min(4096, Math.max(256, Math.ceil(text.length / 2) + 128));

// 生成の末尾が同じ断片の繰り返しになっていないか（暴走の検出）
function isLooping(content) {
  if (content.length < 300) return false;
  const tail = content.slice(-30);
  const recent = content.slice(-600);
  return recent.split(tail).length - 1 >= 4;
}

// 戻り値: { text, truncated }。truncated は上限到達または繰り返しで打ち切ったことを示す
async function ollamaChat(prompt, { ollamaUrl, ollamaModel, ollamaNumCtx, temperature = 0 }, maxTokens = 1024) {
  // 生成の途中で止まった場合にも備え、読み終わるまでを含めてタイムアウトを掛ける
  const ctrl = new AbortController();
  let reason = null; // 'timeout' | 'loop'
  const timer = setTimeout(() => { reason = 'timeout'; ctrl.abort(); }, OLLAMA_TIMEOUT_MS);
  let content = '';
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
          stream: true, // 生成しながら少しずつ受け取る（応答待ちで打ち切られにくく、暴走も途中で検出できる）
          keep_alive: '15m',
          // コンテキスト長は、指定があるときだけ送る（未指定なら Ollama 側の既定値に従う）。
          // 値が他のクライアントと食い違うと、そのたびにモデルが読み込み直されて遅くなる
          options: {
            temperature,
            num_predict: maxTokens,
            ...(Number(ollamaNumCtx) > 0 ? { num_ctx: Number(ollamaNumCtx) } : {}),
          },
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
    let buf = '', truncated = false;
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
        if (j.done && j.done_reason === 'length') truncated = true;
      }
      if (isLooping(content)) {
        // 接続を切ると Ollama 側の生成も止まる
        reason = 'loop';
        ctrl.abort();
        break;
      }
    }
    if (reason === 'loop') console.warn('[translate-toggle] 同じ語句の繰り返しを検出したため生成を打ち切りました');
    return { text: cleanOutput(content), truncated: truncated || reason === 'loop' };
  } catch (e) {
    if (e.name === 'AbortError' && reason === 'loop') return { text: cleanOutput(content), truncated: true };
    if (e.name === 'AbortError') throw new Error(`Ollama の応答が ${OLLAMA_TIMEOUT_MS / 1000} 秒以内に終わりませんでした。`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- プロンプト ----------
const TAG_RULE = 'Keep every <span id="..."> tag with its exact attributes, and put each one around the words that correspond to its original content. Keep <br> tags. Do not translate text inside tags that have class="notranslate".';

// official: TranslateGemma の学習時の形式（原文の言語を明示する形）。汎用のプロンプトより
// 指定と違う言語になりにくい。公式形式にはタグの扱いがないので、タグ付きのときは指示を足す。
function buildPrompt(text, src, tgt, isHtml, official) {
  const T = langName(tgt);
  if (official) {
    const sc = src || 'en'; // 推定できないときは英語とみなす
    const S = langName(sc);
    return `You are a professional ${S} (${sc}) to ${T} (${tgt}) translator. Your goal is to accurately convey the meaning and nuances of the original ${S} text while adhering to ${T} grammar, vocabulary, and cultural sensitivities.
Produce only the ${T} translation, without any additional explanations or commentary.${isHtml ? ` The text is an HTML fragment. ${TAG_RULE}` : ''} Please translate the following ${S} text into ${T}:


${text}`;
  }
  if (isHtml) {
    return `Translate the following HTML fragment into ${T}. Output only the translated fragment, without any explanation.
${TAG_RULE}

${text}`;
  }
  return `Translate the following text into ${T}. Output only the translation, without any explanation.

${text}`;
}

// ---------- 訳文が指定した言語になっているかの簡易チェック ----------
const countMatches = (s, re) => (s.match(re) || []).length;
function looksLikeTarget(out, input, tgt) {
  const o = out.trim();
  if (!o) return false;
  if (o === input.trim()) return true; // 固有名詞やコードなど、訳さずそのまま返すのが正しい場合
  const kana = countMatches(o, /[\u3040-\u30ff]/g);
  const han = countMatches(o, /[\u3400-\u9fff]/g);
  const hangul = countMatches(o, /[\uac00-\ud7af\u1100-\u11ff]/g);
  const other = countMatches(o, /[\u0400-\u04ff\u0600-\u06ff\u0e00-\u0e7f\u0900-\u097f]/g); // キリル・アラビア・タイ・デーヴァナーガリー
  const letters = countMatches(o, /\p{L}/gu);
  const short = o.split(/\s+/).length <= 2 && o.length <= 24; // 短い語句はそのまま残ることがある
  switch (baseLang(tgt)) {
    case 'ja':
      if (hangul || other) return false;
      if (kana) return true;
      if (han) return han <= 12;        // 漢字だけの短い見出しはあり得るが、長文で仮名がなければ中国語の可能性が高い
      return short;                      // ラテン文字だけ = 訳されていない、または別の言語
    case 'ko':
      return hangul > 0 || short;
    case 'zh':
      if (kana || hangul || other) return false;
      return han > 0 || short;
    case 'en':
      return kana + han + hangul + other < letters * 0.2;
    default:
      return true;
  }
}

// ponytail: 4b で測った目安。タグがこの数以上の段落は最初から文ごとに訳す。断片は SPLIT_CHARS 程度にまとめる
const SPLIT_TAGS = 12;
const SPLIT_CHARS = 600;

// タグの外にある文末（. ! ? の後に空白と大文字など、または 。）で区切り、各断片を maxChars 程度にまとめる
function splitSentences(html, maxChars) {
  const parts = [];
  let depth = 0, start = 0;
  const re = /<\/?span\b[^>]*>|[.!?](?=\s+(?:[A-Z(\["]|<))|。/g;
  for (let m; (m = re.exec(html));) {
    if (m[0][0] === '<') { depth += m[0][1] === '/' ? -1 : 1; continue; }
    if (depth === 0) { parts.push(html.slice(start, m.index + 1)); start = m.index + 1; }
  }
  parts.push(html.slice(start));
  const chunks = [];
  for (const p of parts) {
    if (chunks.length && chunks[chunks.length - 1].length + p.length <= maxChars) chunks[chunks.length - 1] += p;
    else chunks.push(p);
  }
  return chunks.filter((c) => c.trim());
}

// タグ付きで翻訳する。styles の順にプロンプトを試し、タグが揃った訳を返す。
// 揃わなければ、そのまま残す要素（数式など）だけは揃っている訳（リンクなどが一部消える）を返し、それもなければ null
async function translateTagged(html, src, s, styles) {
  const plain = unescapeHtml(stripTags(html));
  let partial = null;
  for (const official of styles) {
    const { text: r, truncated } = await ollamaChat(buildPrompt(html, src, s.target, true, official), s, maxTokensFor(html));
    if (truncated || !looksLikeTarget(unescapeHtml(stripTags(r)), plain, s.target)) continue;
    if (tagIds(r) === tagIds(html)) return r;
    if (keepsOpaque(r, html) && (partial === null || tagIds(r).length > tagIds(partial).length)) partial = r;
  }
  return partial;
}

async function translateOllama(texts, s, srcLangs = []) {
  if (!s.ollamaModel) throw new FatalError('モデル名が未設定です。');
  const out = [];
  for (let i = 0; i < texts.length; i++) {
    const html = texts[i];
    const src = srcLangs[i] || null;
    const plain = unescapeHtml(stripTags(html));
    // 原文がすでに翻訳先の言語なら、モデルに渡さずそのまま返す
    if (src && baseLang(src) === baseLang(s.target)) { out.push(html); continue; }

    let result = null;
    // TranslateGemma には公式形式を先に使い、だめなら汎用のプロンプトでもう一度試す
    // （公式形式はタグを落とすことがあり、汎用は違う言語になることがある）
    const styles = /translategemma/i.test(s.ollamaModel) ? [true, false] : [false];
    if (html.includes('<span')) {
      // 文ごとに分けて訳し、つなぎ合わせる。1 つでも訳せなければ null
      const translateChunks = async (chunks) => {
        const parts = [];
        for (const c of chunks) {
          const r = await translateTagged(c, src, s, styles);
          if (r === null) return null;
          parts.push(r);
        }
        return parts.join(' ');
      };
      const chunks = splitSentences(html, SPLIT_CHARS);
      if (chunks.length > 1 && tagIds(html).split(',').length >= SPLIT_TAGS) {
        // 数式やリンクが多い段落は 1 回では保てないことが多いので、最初から文ごとに訳す
        // （失敗してから分けると、失敗した分だけ時間が余計にかかる）
        result = await translateChunks(chunks);
      } else {
        result = await translateTagged(html, src, s, styles);
        if (result === null && chunks.length > 1) result = await translateChunks(chunks);
      }
    }
    // テキストだけで訳すと数式や画像などが消えてしまうので、それらを含む段落では行わない（原文のまま残す）
    if (result === null && !opaqueIds(html).length) {
      // 言語が違えばもう一度。temperature 0 同士だと同じ出力になるので、2 回目は値を変える
      const temps = (s.temperature || 0) === 0 ? [0, 0.3] : [s.temperature, 0];
      for (const temperature of temps) {
        const { text: r, truncated } = await ollamaChat(buildPrompt(plain, src, s.target, false, styles[0]), { ...s, temperature }, maxTokensFor(plain));
        if (!truncated && looksLikeTarget(r, plain, s.target)) { result = escapeHtml(r); break; }
        if (!truncated) console.warn('[translate-toggle] 指定と違う言語の訳を破棄しました:', r.slice(0, 80));
      }
    }
    // それでも指定の言語にならなければ、誤った言語を表示するより原文のまま残す
    out.push(result ?? html);
  }
  return out;
}

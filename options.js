const DEFAULTS = {
  engine: 'azure', apiKey: '', region: '',
  ollamaUrl: 'http://localhost:11434', ollamaModel: 'translategemma:4b', ollamaModelHQ: 'translategemma:12b', ollamaNumCtx: '',
  target: 'ja', hover: true,
};
const $ = (id) => document.getElementById(id);
const status = (text, cls = '') => { $('status').textContent = text; $('status').className = cls; };
let route = '';
async function callTranslator(type, texts) {
  const off = await chrome.runtime.sendMessage({ type: 'ensureOffscreen' });
  const to = off && off.ok ? 'offscreen' : 'background';
  route = to === 'offscreen' ? 'offscreen 経由' : `予備経路（offscreen 不可: ${off?.error || '不明'}）`;
  const res = await chrome.runtime.sendMessage({ type, texts, to });
  if (!res) throw new Error(`翻訳処理から応答がありません（${route}）`);
  return res;
}

// 経過時間を表示しながらテストし、どんな失敗でも結果を画面に出す
async function runTest(type, label, waitingText) {
  await save();
  const started = Date.now();
  const tick = () => status(`${waitingText}（${Math.round((Date.now() - started) / 1000)} 秒経過）`);
  tick();
  const timer = setInterval(tick, 1000);
  try {
    const res = await callTranslator(type, ['Hello, world.']);
    const sec = Math.round((Date.now() - started) / 1000);
    if (res.ok) status(`${label}に接続できました（${sec} 秒、${route}）: 「${res.translations[0]}」`, 'ok');
    else status(res.error === 'NO_KEY' ? 'キーを入力してください' : `接続できません: ${res.error}（${route}）`, 'ng');
  } catch (e) {
    status(`接続できません: ${e.message || e}`, 'ng');
  } finally {
    clearInterval(timer);
    load();
  }
}
const engine = () => document.querySelector('input[name=engine]:checked')?.value || 'azure';

function updateVisibility() {
  const e = engine();
  $('azure-settings').hidden = e !== 'azure';
  $('usage-block').hidden = e !== 'azure';
}

async function load() {
  const s = await chrome.storage.local.get(DEFAULTS);
  document.querySelector(`input[name=engine][value="${s.engine}"]`).checked = true;
  $('apiKey').value = s.apiKey;
  $('region').value = s.region;
  $('ollamaUrl').value = s.ollamaUrl;
  $('ollamaModel').value = s.ollamaModel;
  $('ollamaModelHQ').value = s.ollamaModelHQ;
  $('ollamaNumCtx').value = s.ollamaNumCtx;
  $('target').value = s.target;
  $('hover').checked = s.hover;
  updateVisibility();
  const u = await chrome.runtime.sendMessage({ type: 'getUsage' });
  $('usage').textContent = `${u.chars.toLocaleString()} 文字（${u.month}）`;
}

async function save() {
  await chrome.storage.local.set({
    engine: engine(),
    apiKey: $('apiKey').value.trim(),
    region: $('region').value.trim(),
    ollamaUrl: $('ollamaUrl').value.trim() || DEFAULTS.ollamaUrl,
    ollamaModel: $('ollamaModel').value.trim(),
    ollamaModelHQ: $('ollamaModelHQ').value.trim(),
    ollamaNumCtx: $('ollamaNumCtx').value.trim(),
    target: $('target').value,
    hover: $('hover').checked,
  });
  status('保存しました', 'ok');
}

document.querySelectorAll('input[name=engine]').forEach((r) => r.addEventListener('change', updateVisibility));
$('save').addEventListener('click', save);
$('test').addEventListener('click', () => runTest('translate', '翻訳エンジン',
  engine().startsWith('ollama') ? 'テスト中…初回はモデルの読み込みに時間がかかります' : 'テスト中…'));
$('testHQ').addEventListener('click', () => runTest('translateHQ', '再翻訳モデル',
  'テスト中…初回はモデルの読み込みに時間がかかります'));
load();

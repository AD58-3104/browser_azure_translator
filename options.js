const DEFAULTS = {
  engine: 'azure', apiKey: '', region: '',
  ollamaUrl: 'http://localhost:11434', ollamaModel: 'translategemma:4b',
  target: 'ja', hover: true,
};
const $ = (id) => document.getElementById(id);
const status = (text, cls = '') => { $('status').textContent = text; $('status').className = cls; };
const engine = () => document.querySelector('input[name=engine]:checked')?.value || 'azure';

function updateVisibility() {
  const e = engine();
  $('azure-settings').hidden = e !== 'azure';
  $('usage-block').hidden = e !== 'azure';
  $('ollama-settings').hidden = e !== 'ollama';
}

async function load() {
  const s = await chrome.storage.local.get(DEFAULTS);
  document.querySelector(`input[name=engine][value="${s.engine}"]`).checked = true;
  $('apiKey').value = s.apiKey;
  $('region').value = s.region;
  $('ollamaUrl').value = s.ollamaUrl;
  $('ollamaModel').value = s.ollamaModel;
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
    target: $('target').value,
    hover: $('hover').checked,
  });
  status('保存しました', 'ok');
}

document.querySelectorAll('input[name=engine]').forEach((r) => r.addEventListener('change', updateVisibility));
$('save').addEventListener('click', save);
$('test').addEventListener('click', async () => {
  await save();
  status(engine() === 'ollama' ? 'テスト中…（初回はモデルの読み込みに時間がかかります）' : 'テスト中…');
  const res = await chrome.runtime.sendMessage({ type: 'translate', texts: ['Hello, world.'] });
  if (res.ok) status(`接続できました: 「${res.translations[0]}」`, 'ok');
  else status(res.error === 'NO_KEY' ? 'キーを入力してください' : `接続できません: ${res.error}`, 'ng');
  load();
});
load();

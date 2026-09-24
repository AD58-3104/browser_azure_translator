const DEFAULTS = { apiKey: '', region: '', target: 'ja', hover: true };
const $ = (id) => document.getElementById(id);
const status = (text, cls = '') => { $('status').textContent = text; $('status').className = cls; };

async function load() {
  const s = await chrome.storage.local.get(DEFAULTS);
  $('apiKey').value = s.apiKey;
  $('region').value = s.region;
  $('target').value = s.target;
  $('hover').checked = s.hover;
  const u = await chrome.runtime.sendMessage({ type: 'getUsage' });
  $('usage').textContent = `${u.chars.toLocaleString()} 文字（${u.month}）`;
}

async function save() {
  await chrome.storage.local.set({
    apiKey: $('apiKey').value.trim(),
    region: $('region').value.trim(),
    target: $('target').value,
    hover: $('hover').checked,
  });
  status('保存しました', 'ok');
}

$('save').addEventListener('click', save);
$('test').addEventListener('click', async () => {
  await save();
  status('テスト中…');
  const res = await chrome.runtime.sendMessage({ type: 'translate', texts: ['Hello, world.'] });
  if (res.ok) status(`接続できました: 「${res.translations[0]}」`, 'ok');
  else status(res.error === 'NO_KEY' ? 'キーを入力してください' : `接続できません: ${res.error}`, 'ng');
  load();
});
load();

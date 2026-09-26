// 翻訳 API の呼び出しを担当する offscreen document。
// Service Worker は「fetch の応答が 30 秒以上来ない」「30 秒間イベントがない」と
// 強制終了されるため、時間のかかる推論や 429 の待機はこちらで行う。
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.to !== 'offscreen') return;
  if (!['translate', 'translateHQ', 'translateLight'].includes(msg.type)) return;
  (async () => {
    const s = await chrome.runtime.sendMessage({ type: 'getSettings' });
    if (!s) return { ok: false, fatal: false, error: '設定を読み込めませんでした。' };
    return runTranslationSafe(msg, s, (n) => chrome.runtime.sendMessage({ type: 'addUsage', n }));
  })().then(sendResponse);
  return true;
});

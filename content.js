// ページ内の翻訳単位を管理し、原文⇄訳文を差し替える。
(() => {
  if (window.__azTranslateToggle) return;
  window.__azTranslateToggle = true;

  // 文中に現れるインライン要素（訳文でも構造を保つ）
  const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'data', 'dfn', 'em', 'font', 'i',
    'label', 'mark', 'q', 'ruby', 'rt', 'rp', 's', 'small', 'span', 'strong', 'sub', 'sup', 'time',
    'u', 'del', 'ins', 'wbr']);
  // 翻訳せずそのまま残すインライン要素
  const OPAQUE = new Set(['code', 'kbd', 'samp', 'var', 'img', 'svg', 'math', 'canvas', 'picture', 'video', 'audio']);
  // 中身を一切触らない要素
  const SKIP = new Set(['script', 'style', 'noscript', 'textarea', 'input', 'select', 'option', 'pre',
    'svg', 'math', 'canvas', 'iframe', 'object', 'embed', 'video', 'audio', 'template', 'head']);
  const MAX_UNIT_CHARS = 8000;
  const MAX_BATCH_CHARS = 20000;

  const units = [];
  const claimed = new WeakSet();    // 翻訳単位に組み込んだ元のノード
  const ours = new WeakSet();       // 拡張機能が作ったノード
  const nodeToUnit = new WeakMap(); // 訳文ノード → 単位
  const parentUnits = new WeakMap();// 親要素 → 単位リスト

  let active = false;
  let mode = 'original';
  let settings = { target: 'ja', hover: true, engine: 'azure' };

  const isNoTranslate = (el) => el.getAttribute('translate') === 'no' || el.classList.contains('notranslate');
  const isInline = (el) => INLINE.has(el.localName) || OPAQUE.has(el.localName);
  const isOpaque = (el) => OPAQUE.has(el.localName) || isNoTranslate(el);

  function needsTranslation(text) {
    const t = text.trim();
    if (!/\p{L}/u.test(t)) return false;                         // 数字や記号だけ
    if (settings.target === 'ja' && /[\u3040-\u30ff]/.test(t)) return false; // すでに日本語
    return true;
  }

  // ---------- 走査 ----------
  function scan(root) {
    if (root.nodeType !== 1 || ours.has(root) || root === host) return;
    if (SKIP.has(root.localName) || root.isContentEditable || isNoTranslate(root)) return;
    let run = [];
    const flush = () => { if (run.length) makeUnit(root, run); run = []; };
    for (const child of Array.from(root.childNodes)) {
      if (claimed.has(child) || ours.has(child)) { flush(); continue; }
      if (child.nodeType === 3 || child.nodeType === 8) run.push(child);
      else if (child.nodeType === 1 && isInline(child)) run.push(child);
      else if (child.nodeType === 1) { flush(); scan(child); }
    }
    flush();
  }

  function makeUnit(parent, run) {
    const meaningful = run.filter((n) => n.nodeType === 1 || (n.nodeType === 3 && n.nodeValue.trim()));
    // 要素一つだけのまとまりなら中に降りて、その要素自体（リンク等）を保持する
    if (meaningful.length === 1 && meaningful[0].nodeType === 1 && !isOpaque(meaningful[0])) {
      return scan(meaningful[0]);
    }
    const text = run.map((n) => (n.nodeType === 8 ? '' : n.textContent)).join('');
    if (!needsTranslation(text)) return;
    if (text.length > MAX_UNIT_CHARS) {
      for (const n of run) if (n.nodeType === 1 && !isOpaque(n)) scan(n);
      return;
    }
    const textOnly = run.every((n) => n.nodeType !== 1);
    const unit = { parent, original: run, kind: textOnly ? 'text' : 'mixed', state: 'original' };
    if (textOnly) unit.origValues = run.map((n) => (n.nodeType === 3 ? n.nodeValue : null));
    run.forEach((n) => claimed.add(n));
    units.push(unit);
    if (!parentUnits.has(parent)) parentUnits.set(parent, []);
    parentUnits.get(parent).push(unit);
    observeUnit(unit);
  }

  // ---------- 見えている範囲だけ翻訳（無料枠の節約） ----------
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      (parentUnits.get(e.target) || []).forEach(enqueue);
    }
  }, { rootMargin: '100% 0px' });
  const observeUnit = (u) => io.observe(u.parent);

  let queue = [];
  let flushing = false;
  let timer = null;
  let errorShown = false;
  const failed = new Set(); // 失敗した単位。次に訳文表示へ切り替えたとき再試行する
  const MAX_TRIES = 3;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function enqueue(u) {
    if (u.requested || u.dead) return;
    u.requested = true;
    u.payload = serialize(u);
    queue.push(u);
    clearTimeout(timer);
    timer = setTimeout(flushQueue, 60);
  }

  // offscreen の翻訳処理を呼ぶ。通信自体の失敗（拡張機能側の再起動など）は数回まで再試行
  async function callTranslator(type, texts, extra = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // offscreen を使えればそちらで、使えなければ Service Worker で直接翻訳する
        const off = await chrome.runtime.sendMessage({ type: 'ensureOffscreen' });
        const to = off && off.ok ? 'offscreen' : 'background';
        const res = await chrome.runtime.sendMessage({ type, texts, to, ...extra });
        if (res) return res;
      } catch (e) {
        if (/context invalidated/i.test(e.message)) {
          return { ok: false, fatal: true, error: '拡張機能が更新されました。ページを再読み込みしてください。' };
        }
      }
      await sleep(1000 * (attempt + 1));
    }
    return { ok: false, fatal: false, error: '翻訳処理と通信できませんでした。' };
  }

  async function flushQueue() {
    if (flushing) return;
    flushing = true;
    try {
      while (queue.length) {
        const batch = [];
        let chars = 0;
        // ローカル推論は1段落ずつ送り、訳せたものから順に表示する
        const maxItems = settings.engine.startsWith('ollama') ? 1 : 100;
        while (queue.length && batch.length < maxItems) {
          const len = queue[0].payload.html.length;
          if (batch.length && chars + len > MAX_BATCH_CHARS) break;
          batch.push(queue.shift());
          chars += len;
        }
        const res = await callTranslator('translate', batch.map((u) => u.payload.html));

        if (res.ok) {
          res.translations.forEach((html, i) => {
            try { applyTranslation(batch[i], html); }
            catch (e) { batch[i].dead = true; console.warn('[translate-toggle] apply failed', e); }
          });
          continue;
        }
        if (res.fatal) {
          // 設定の問題など。残りも止めて、設定を直したあとの切り替えで再開する
          for (const u of batch.concat(queue)) { u.requested = false; failed.add(u); }
          queue = [];
          showError(res.error);
          break;
        }
        // 一時的な失敗：この単位だけ後ろに回して再試行し、ほかの段落の翻訳は続ける
        console.warn('[translate-toggle]', res.error);
        for (const u of batch) {
          u.tries = (u.tries || 0) + 1;
          if (u.tries < MAX_TRIES) queue.push(u);
          else { u.requested = false; u.tries = 0; failed.add(u); }
        }
        if (batch.some((u) => failed.has(u))) showError(`一部の段落を翻訳できませんでした（${res.error}）。Alt+T で原文に戻して再度 Alt+T を押すと再試行します。`);
        await sleep(2000);
      }
    } finally {
      flushing = false;
    }
  }

  function retryFailed() {
    const list = [...failed];
    failed.clear();
    for (const u of list) if (!u.dead && u.parent.isConnected) enqueue(u);
  }

  // ---------- シリアライズ / 復元 ----------
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function serialize(unit) {
    const refs = [];
    const ser = (node) => {
      if (node.nodeType === 3) return esc(node.nodeValue);
      if (node.nodeType !== 1) return '';
      if (node.localName === 'br') return '<br>';
      const i = refs.push(node) - 1;
      if (isOpaque(node)) {
        return `<span id="k${i}" class="notranslate">${esc(node.textContent.trim()) || '#'}</span>`;
      }
      return `<span id="k${i}">${Array.from(node.childNodes).map(ser).join('')}</span>`;
    };
    return { html: unit.original.map(ser).join(''), refs };
  }

  function build(src, refs) {
    const out = [];
    for (const n of src.childNodes) {
      if (n.nodeType === 3) { out.push(document.createTextNode(n.nodeValue)); continue; }
      if (n.nodeType !== 1) continue;
      if (n.localName === 'br') { out.push(document.createElement('br')); continue; }
      const m = /^k(\d+)$/.exec(n.id || '');
      const ref = m ? refs[Number(m[1])] : null;
      if (!ref) { out.push(...build(n, refs)); continue; }
      if (isOpaque(ref)) { out.push(ref.cloneNode(true)); continue; }
      const el = ref.cloneNode(false);
      el.append(...build(n, refs));
      out.push(el);
    }
    return out;
  }

  function parseHtml(html) {
    const tpl = document.createElement('template'); // 不活性なのでスクリプト等は実行されない
    tpl.innerHTML = html;
    return tpl.content;
  }

  // 原文の前後の空白を訳文にも残す
  function keepSpaces(origText, nodes) {
    const lead = /^\s/.test(origText), trail = /\s$/.test(origText);
    if (lead) nodes.unshift(document.createTextNode(' '));
    if (trail) nodes.push(document.createTextNode(' '));
    return nodes;
  }

  function applyTranslation(unit, html) {
    if (unit.dead) return;
    const origText = unit.original.map((n) => (n.nodeType === 8 ? '' : n.textContent)).join('');
    if (unit.kind === 'text') {
      let t = parseHtml(html).textContent;
      if (/^\s/.test(origText) && !/^\s/.test(t)) t = ' ' + t;
      if (/\s$/.test(origText) && !/\s$/.test(t)) t = t + ' ';
      unit.transValue = t;
    } else {
      let nodes = keepSpaces(origText, build(parseHtml(html), unit.payload.refs));
      if (!nodes.length) nodes = [document.createTextNode('')];
      nodes.forEach((n) => { ours.add(n); nodeToUnit.set(n, unit); });
      unit.translated = nodes;
    }
    unit.ready = true;
    if (mode === 'translated') show(unit, 'translated');
  }

  // ---------- 差し替え ----------
  function show(unit, which) {
    if (!unit.ready || unit.dead || unit.state === which) return;
    if (unit.kind === 'text') {
      // テキストノード自体は置き換えず値だけ変える（React等のページを壊しにくい）
      const texts = unit.original.filter((n) => n.nodeType === 3);
      const origVals = unit.origValues.filter((v) => v !== null);
      const transVals = texts.map((_, i) => (i === 0 ? unit.transValue : ''));
      const current = unit.state === 'original' ? origVals : transVals;
      if (texts.some((n, i) => n.nodeValue !== current[i])) { unit.dead = true; return; } // ページ側が書き換えた
      const next = which === 'original' ? origVals : transVals;
      texts.forEach((n, i) => { n.nodeValue = next[i]; });
    } else {
      const from = unit.state === 'original' ? unit.original : unit.translated;
      const to = which === 'original' ? unit.original : unit.translated;
      if (from.some((n) => n.parentNode !== unit.parent)) { unit.dead = true; return; }
      for (const n of to) unit.parent.insertBefore(n, from[0]);
      for (const n of from) n.remove();
    }
    unit.state = which;
  }

  // ---------- 動的に追加される内容 ----------
  let pendingRoots = new Set();
  let mutTimer = null;
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (ours.has(n) || claimed.has(n)) continue;
        if (n.nodeType === 1 && !isInline(n)) pendingRoots.add(n);
        else if (m.target.nodeType === 1) pendingRoots.add(m.target);
      }
    }
    if (pendingRoots.size) {
      clearTimeout(mutTimer);
      mutTimer = setTimeout(() => {
        const roots = pendingRoots; pendingRoots = new Set();
        roots.forEach((r) => { if (r.isConnected) scan(r); });
      }, 300);
    }
  });

  // ---------- UI（原文ツールチップ・エラー表示） ----------
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;';
  ours.add(host);
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>
    .tip, .toast { position: fixed; z-index: 2147483647; font: 13px/1.6 system-ui, sans-serif;
      background: #1f2937; color: #f9fafb; border-radius: 6px; padding: 8px 10px;
      box-shadow: 0 4px 16px rgba(0,0,0,.25); pointer-events: none; }
    .tip { max-width: min(520px, 90vw); display: none; white-space: pre-wrap; }
    .toast { right: 16px; bottom: 16px; max-width: 360px; display: none; }
    .toast.error { background: #991b1b; }
    .busy { position: absolute; z-index: 2147483647; font: 12px/1.5 system-ui, sans-serif; background: #1f2937;
      color: #f9fafb; padding: 2px 8px; border-radius: 4px; pointer-events: none; }
    .flash { position: absolute; z-index: 2147483647; border: 2px solid #2563eb; border-radius: 6px;
      pointer-events: none; animation: fade 1.8s forwards; }
    @keyframes fade { 0%, 60% { opacity: 1; } 100% { opacity: 0; } }
  </style><div class="tip"></div><div class="toast"></div>`;
  const tip = shadow.querySelector('.tip');
  const toast = shadow.querySelector('.toast');

  let toastTimer = null;
  function showToast(text, isError = false) {
    toast.textContent = text;
    toast.className = isError ? 'toast error' : 'toast';
    toast.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.style.display = 'none'; errorShown = false; }, 6000);
  }

  function showError(err) {
    if (errorShown) return;
    errorShown = true;
    showToast(err === 'NO_KEY'
      ? 'APIキーが未設定です。拡張機能のオプションで Azure Translator のキーを設定してください。'
      : `翻訳に失敗しました: ${err}`, true);
    chrome.runtime.sendMessage({ type: 'state', state: 'error' });
  }

  // ページ座標で要素の位置に印を出す
  function placeAt(div, el, pad = 0) {
    const r = el.getBoundingClientRect();
    div.style.left = r.left + scrollX - pad + 'px';
    div.style.top = r.top + scrollY - pad + 'px';
    return r;
  }
  function showBusy(el, label) {
    const d = document.createElement('div');
    d.className = 'busy';
    d.textContent = `${label} で再翻訳中…`;
    shadow.appendChild(d);
    placeAt(d, el);
    d.style.top = Math.max(0, parseFloat(d.style.top) - 24) + 'px';
    return d;
  }
  function flash(el) {
    const d = document.createElement('div');
    d.className = 'flash';
    shadow.appendChild(d);
    const r = placeAt(d, el, 4);
    d.style.width = r.width + 8 + 'px';
    d.style.height = r.height + 8 + 'px';
    setTimeout(() => d.remove(), 1800);
  }

  // ---------- マウスの下の段落を再翻訳 ----------
  // which: 'hq'（高品質モデル）| 'light'（通常モデル）, model: 表示用のモデル名
  async function retranslateAtCursor(which, model, engine) {
    if (!active || mode !== 'translated' || !lastMouse) return;
    const el = document.elementFromPoint(lastMouse.clientX, lastMouse.clientY);
    const us = (el ? unitsAt(el) : []).filter((u) => u.ready && !u.dead && !u.rePending);
    if (!us.length) { showToast('再翻訳したい段落の上にマウスを置いてから押してください。'); return; }
    // いまの訳と同じモデルで訳し直す場合は、別の訳が出るよう揺らぎを入れる
    const initialSource = { ollama: 'light', ollamaHQ: 'hq' }[engine]; // ページ翻訳に使ったモデル
    const sameModel = (u) => (u.source || initialSource) === which;
    const vary = us.some(sameModel);
    const label = model || (which === 'hq' ? '高品質モデル' : '通常モデル');
    const anchor = us[0].parent;
    const busy = showBusy(anchor, label);
    us.forEach((u) => { u.rePending = true; });
    try {
      const type = which === 'hq' ? 'translateHQ' : 'translateLight';
      const res = await callTranslator(type, us.map((u) => u.payload.html), { vary });
      if (!res.ok) { showError(res.error); return; }
      res.translations.forEach((html, i) => {
        const u = us[i];
        if (u.state === 'translated') show(u, 'original'); // 旧訳を外してから差し替え
        if (u.dead) return;
        applyTranslation(u, html);
        u.source = which;
        u.sourceLabel = label;
      });
      if (anchor.isConnected) flash(anchor);
    } finally {
      busy.remove();
      us.forEach((u) => { u.rePending = false; });
    }
  }

  function unitsAt(el) {
    for (let n = el; n && n !== document.body; n = n.parentNode) {
      if (nodeToUnit.has(n)) return [nodeToUnit.get(n)];
      if (parentUnits.has(n)) return parentUnits.get(n).filter((u) => u.state === 'translated');
    }
    return [];
  }

  let lastMouse = null;
  function updateTip(x, y, ctrl) {
    if (!settings.hover || !ctrl || mode !== 'translated') { tip.style.display = 'none'; return; }
    const el = document.elementFromPoint(x, y);
    const us = el ? unitsAt(el) : [];
    if (!us.length) { tip.style.display = 'none'; return; }
    const labels = [...new Set(us.filter((u) => u.sourceLabel).map((u) => u.sourceLabel))];
    tip.textContent = (labels.length ? `［${labels.join('・')} で再翻訳済み］\n` : '') + us.map((u) => u.original.map((n) => (n.nodeType === 8 ? '' : n.textContent)).join('')
      .replace(/\s+/g, ' ').trim()).join('\n');
    tip.style.display = 'block';
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.min(x + 12, innerWidth - r.width - 8) + 'px';
    tip.style.top = (y + 16 + r.height > innerHeight ? y - r.height - 12 : y + 16) + 'px';
  }
  addEventListener('mousemove', (e) => { lastMouse = e; updateTip(e.clientX, e.clientY, e.ctrlKey); }, true);
  addEventListener('keydown', (e) => { if (e.key === 'Control' && lastMouse) updateTip(lastMouse.clientX, lastMouse.clientY, true); }, true);
  addEventListener('keyup', (e) => { if (e.key === 'Control') tip.style.display = 'none'; }, true);
  addEventListener('scroll', () => { tip.style.display = 'none'; }, true);

  // ---------- 切り替え ----------
  function activate() {
    active = true;
    document.documentElement.appendChild(host);
    scan(document.body);
    mo.observe(document.body, { childList: true, subtree: true });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'retranslate') { retranslateAtCursor(msg.which, msg.model, msg.engine); sendResponse(true); return; }
    if (msg.type !== 'toggle') return;
    settings = { target: msg.target || 'ja', hover: msg.hover !== false, engine: msg.engine || 'azure' };
    if (!active) { activate(); mode = 'translated'; }
    else mode = mode === 'translated' ? 'original' : 'translated';
    if (mode === 'translated') retryFailed();
    units.forEach((u) => show(u, mode));
    if (mode === 'original') tip.style.display = 'none';
    sendResponse(mode);
  });
})();

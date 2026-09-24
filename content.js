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
  let settings = { target: 'ja', hover: true };

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

  function enqueue(u) {
    if (u.requested || u.dead) return;
    u.requested = true;
    u.payload = serialize(u);
    queue.push(u);
    clearTimeout(timer);
    timer = setTimeout(flushQueue, 60);
  }

  async function flushQueue() {
    if (flushing) return;
    flushing = true;
    try {
      while (queue.length) {
        const batch = [];
        let chars = 0;
        while (queue.length && batch.length < 100) {
          const len = queue[0].payload.html.length;
          if (batch.length && chars + len > MAX_BATCH_CHARS) break;
          batch.push(queue.shift());
          chars += len;
        }
        const res = await chrome.runtime.sendMessage({ type: 'translate', texts: batch.map((u) => u.payload.html) });
        if (!res || !res.ok) {
          batch.concat(queue).forEach((u) => { u.requested = false; });
          queue = [];
          showError(res ? res.error : 'no response');
          break;
        }
        res.translations.forEach((html, i) => applyTranslation(batch[i], html));
      }
    } finally {
      flushing = false;
    }
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
  ours.add(host);
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>
    .tip, .toast { position: fixed; z-index: 2147483647; font: 13px/1.6 system-ui, sans-serif;
      background: #1f2937; color: #f9fafb; border-radius: 6px; padding: 8px 10px;
      box-shadow: 0 4px 16px rgba(0,0,0,.25); pointer-events: none; }
    .tip { max-width: min(520px, 90vw); display: none; white-space: pre-wrap; }
    .toast { right: 16px; bottom: 16px; max-width: 360px; background: #991b1b; display: none; }
  </style><div class="tip"></div><div class="toast"></div>`;
  const tip = shadow.querySelector('.tip');
  const toast = shadow.querySelector('.toast');

  function showError(err) {
    if (errorShown) return;
    errorShown = true;
    toast.textContent = err === 'NO_KEY'
      ? 'APIキーが未設定です。拡張機能のオプションで Azure Translator のキーを設定してください。'
      : `翻訳に失敗しました: ${err}`;
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; errorShown = false; }, 6000);
    chrome.runtime.sendMessage({ type: 'state', state: 'error' });
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
    tip.textContent = us.map((u) => u.original.map((n) => (n.nodeType === 8 ? '' : n.textContent)).join('')
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
    if (msg.type !== 'toggle') return;
    settings = { target: msg.target || 'ja', hover: msg.hover !== false };
    if (!active) { activate(); mode = 'translated'; }
    else mode = mode === 'translated' ? 'original' : 'translated';
    units.forEach((u) => show(u, mode));
    if (mode === 'original') tip.style.display = 'none';
    sendResponse(mode);
  });
})();

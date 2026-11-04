/**
 * The visual editor script for hosted static sites (migration 0046).
 * Served by the site router at /__3t_edit/editor.js ONLY into pages
 * carrying a valid edit session — public visitors never receive it.
 * A single self-contained file: no dependencies, no build step; it
 * reads its candidate snapshot from window.__3T_EDIT__ (injected by
 * the router alongside the script tag), highlights the elements that
 * contain the demo seed strings, and lets the buyer preview
 * replacements inline before the one-shot finalize.
 *
 * Written without template literals on purpose: the whole script is
 * embedded below as one literal so it can be served verbatim.
 */
export const EDITOR_SCRIPT = `(function () {
  'use strict';
  var boot = window.__3T_EDIT__ || {};
  var candidates = boot.candidates || [];
  var FINALIZE_URL = boot.finalizeUrl || '/__3t_edit/finalize';
  var STATUS_URL = boot.statusUrl || '/__3t_edit/status';
  var EXIT_URL = boot.exitUrl || '/__3t_edit/exit';
  var lang = (document.documentElement.getAttribute('lang') || 'vi').toLowerCase().indexOf('en') === 0 ? 'en' : 'vi';
  var STR = {
    vi: {
      warn: 'Chế độ sửa trực quan: đây là LẦN SỬA DUY NHẤT của website tĩnh này. Khi bấm Hoàn tất, thông tin sẽ bị khóa và không sửa lại được.',
      panelTitle: 'Nội dung mẫu có thể sửa',
      hint: 'Bấm vào phần được viền tím trên trang, hoặc chọn một mục trong danh sách này.',
      finalize: 'Hoàn tất',
      exit: 'Thoát',
      changed: 'mục đã đổi',
      valueVi: 'Tiếng Việt',
      valueEn: 'English',
      value: 'Nội dung',
      imageUrl: 'Đường dẫn ảnh mới (URL)',
      preview: 'Áp dụng xem trước',
      backToList: 'Quay lại danh sách',
      headNote: 'Mục này nằm ở tiêu đề trang / mô tả tìm kiếm nên không hiện trên trang.',
      confirmTitle: 'Kiểm tra lại trước khi khóa',
      confirmBody: 'Sau khi bấm Hoàn tất và khóa, các thay đổi dưới đây sẽ được ghi vào website và KHÓA VĨNH VIỄN. Đây là lần sửa duy nhất, hãy kiểm tra kỹ.',
      confirmLock: 'Hoàn tất và khóa',
      back: 'Quay lại kiểm tra',
      noChanges: 'Bạn chưa thay đổi mục nào.',
      applying: 'Đang ghi thông tin vào website…',
      done: 'Xong! Website đã mang thông tin của bạn và lần sửa đã khóa.',
      failed: 'Hệ thống chưa tự ghi được thay đổi. Đội ngũ sẽ kiểm tra và xử lý cho bạn, bạn không cần làm lại.',
      viewSite: 'Xem website',
      current: 'hiện tại'
    },
    en: {
      warn: 'Visual editing: this is the ONLY edit for this static website. Once you finish, the information is locked and cannot be changed again.',
      panelTitle: 'Template content you can edit',
      hint: 'Click a purple-outlined part of the page, or pick an item from this list.',
      finalize: 'Finish',
      exit: 'Exit',
      changed: 'items changed',
      valueVi: 'Tiếng Việt',
      valueEn: 'English',
      value: 'Content',
      imageUrl: 'New image URL',
      preview: 'Preview change',
      backToList: 'Back to list',
      headNote: 'This item lives in the page title / search description, so it is not visible on the page itself.',
      confirmTitle: 'Review before locking',
      confirmBody: 'After you press Finish and lock, the changes below are written to the website and locked PERMANENTLY. This is the only edit, so please check carefully.',
      confirmLock: 'Finish and lock',
      back: 'Back to editing',
      noChanges: 'You have not changed anything yet.',
      applying: 'Writing your information to the website…',
      done: 'Done! The website now shows your information and this edit is locked.',
      failed: 'The changes could not be written automatically. Our team will check and handle it for you; no need to redo anything.',
      viewSite: 'View website',
      current: 'current'
    }
  };
  var S = STR[lang] || STR.vi;
  var LABELS = {
    'site.name': ['Tên cơ sở / doanh nghiệp', 'Business name'],
    'site.phone': ['Số điện thoại', 'Phone'],
    'site.email': ['Email', 'Email'],
    'site.address': ['Địa chỉ', 'Address'],
    'site.tagline': ['Khẩu hiệu', 'Tagline'],
    'site.hours': ['Giờ mở cửa', 'Opening hours'],
    'site.capacity': ['Quy mô', 'Capacity'],
    'hero.image': ['Ảnh bìa lớn', 'Hero image'],
    'hero.title': ['Tiêu đề chính', 'Main heading'],
    'hero.lead': ['Đoạn giới thiệu đầu trang', 'Intro paragraph'],
    'hero.chipHours': ['Chip giờ mở cửa', 'Opening-hours chip'],
    'hero.chipAddress': ['Chip địa chỉ', 'Address chip'],
    'hero.chipCapacity': ['Chip quy mô', 'Capacity chip'],
    'hero.cardLabel': ['Nhãn thẻ nổi bật', 'Featured card label'],
    'hero.ctaMenu': ['Nút xem danh mục', 'Menu button'],
    'hero.ctaBook': ['Nút đặt mua / đặt lịch', 'Booking button'],
    'about': ['Giới thiệu', 'About']
  };
  var LEAF_LABELS = {
    'lead': ['Đoạn giới thiệu', 'Intro paragraph'],
    'subtitle': ['Tiêu đề phụ', 'Subtitle'],
    'desc': ['Mô tả', 'Description'],
    'text': ['Nội dung', 'Text'],
    'author': ['Người viết', 'Author'],
    'badge': ['Nhãn nhỏ', 'Badge'],
    'note': ['Ghi chú', 'Note'],
    'q': ['Câu hỏi', 'Question'],
    'a': ['Câu trả lời', 'Answer'],
    'addressLine': ['Dòng địa chỉ', 'Address line'],
    'phoneLine': ['Dòng số điện thoại', 'Phone line'],
    'hoursLine': ['Dòng giờ mở cửa', 'Hours line'],
    'emailLine': ['Dòng email', 'Email line'],
    'contactHeading': ['Tiêu đề mục liên hệ', 'Contact heading'],
    'linksHeading': ['Tiêu đề mục đường dẫn', 'Links heading']
  };
  function humanizeId(id) {
    var parts = id.split('.');
    var words = [];
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      var w = '';
      for (var j = 0; j < seg.length; j++) {
        var ch = seg.charAt(j);
        if (j > 0 && ch >= 'A' && ch <= 'Z') w += ' ';
        w += ch.toLowerCase();
      }
      if (w && w !== 'items') words.push(w);
    }
    return words.join(' · ');
  }
  function labelFor(c) {
    var hit = LABELS[c.id];
    if (hit) return lang === 'en' ? hit[1] : hit[0];
    var parts = c.id.split('.');
    var last = parts[parts.length - 1];
    if (last === 'name' || last === 'title') return (lang === 'en' ? 'Name: ' : 'Tên: ') + c.id.replace(/\\.items\\./g, ' #').replace(/\\./g, ' ');
    if (last === 'image') return (lang === 'en' ? 'Image: ' : 'Ảnh: ') + c.id;
    if (/price/i.test(last)) return (lang === 'en' ? 'Price: ' : 'Giá: ') + c.id;
    var leaf = LEAF_LABELS[last];
    if (leaf) return lang === 'en' ? leaf[1] : leaf[0];
    return humanizeId(c.id) || c.id;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  var storeKey = 't3e_changes_' + location.pathname;
  var changes = {};
  try { changes = JSON.parse(sessionStorage.getItem(storeKey) || '{}') || {}; } catch (e) { changes = {}; }
  function persist() { try { sessionStorage.setItem(storeKey, JSON.stringify(changes)); } catch (e) {} }
  function currentOf(c) {
    var ch = changes[c.id] || {};
    return {
      vi: ch.vi !== undefined ? ch.vi : c.vi,
      en: ch.en !== undefined ? ch.en : c.en,
      url: ch.url !== undefined ? ch.url : c.url
    };
  }
  function stringsOf(c) {
    var cur = currentOf(c);
    var out = [];
    [c.vi, c.en, cur.vi, cur.en, c.url, cur.url].forEach(function (v) { if (v && out.indexOf(v) === -1) out.push(v); });
    return out;
  }
  // ---------- DOM matching ----------
  function inEditor(node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    while (el) { if (el.id === 't3e-root' || el.id === 't3e-banner') return true; el = el.parentElement; }
    return false;
  }
  function findTargets(c) {
    var strs = stringsOf(c);
    var found = [];
    var head = false;
    if (c.kind === 'image') {
      var imgs = document.images;
      for (var i = 0; i < imgs.length; i++) {
        var raw = imgs[i].getAttribute('src') || '';
        var path = '';
        try { path = new URL(imgs[i].src, location.href).pathname.replace(/^\\//, ''); } catch (e) {}
        if (strs.indexOf(raw) !== -1 || strs.indexOf(path) !== -1 || strs.indexOf(imgs[i].src) !== -1) found.push(imgs[i]);
      }
      return { els: found, head: false };
    }
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (inEditor(node)) return NodeFilter.FILTER_REJECT;
        var t = node.nodeValue || '';
        for (var j = 0; j < strs.length; j++) if (t.indexOf(strs[j]) !== -1) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_REJECT;
      }
    });
    var n;
    while ((n = walker.nextNode())) { if (n.parentElement) found.push(n.parentElement); }
    var attrEls = document.querySelectorAll('[data-en],[data-vi],[data-desc-en],[data-desc-vi]');
    for (var k = 0; k < attrEls.length; k++) {
      var el = attrEls[k];
      if (inEditor(el)) continue;
      var attrs = ['data-en', 'data-vi', 'data-desc-en', 'data-desc-vi'];
      for (var a = 0; a < attrs.length; a++) {
        var v = el.getAttribute(attrs[a]) || '';
        var hitAttr = false;
        for (var s2 = 0; s2 < strs.length; s2++) if (v.indexOf(strs[s2]) !== -1) { hitAttr = true; break; }
        if (hitAttr) { found.push(el); break; }
      }
    }
    if (document.title && strs.some(function (s) { return document.title.indexOf(s) !== -1; })) head = true;
    var meta = document.querySelector('meta[name="description"]');
    if (meta && strs.some(function (s) { return (meta.getAttribute('content') || '').indexOf(s) !== -1; })) head = true;
    var uniq = [];
    found.forEach(function (el) { if (uniq.indexOf(el) === -1) uniq.push(el); });
    var deepest = uniq.filter(function (el) {
      return !uniq.some(function (other) { return other !== el && el.contains(other); });
    });
    return { els: deepest, head: head };
  }
  function replaceEverywhere(from, to) {
    if (!from || from === to) return;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (inEditor(node)) return NodeFilter.FILTER_REJECT;
        return (node.nodeValue || '').indexOf(from) !== -1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    var nodes = [];
    var n;
    while ((n = walker.nextNode())) nodes.push(n);
    nodes.forEach(function (node) { node.nodeValue = node.nodeValue.split(from).join(to); });
    var attrEls = document.querySelectorAll('[data-en],[data-vi],[data-desc-en],[data-desc-vi]');
    for (var i = 0; i < attrEls.length; i++) {
      ['data-en', 'data-vi', 'data-desc-en', 'data-desc-vi'].forEach(function (attr) {
        var v = attrEls[i].getAttribute(attr);
        if (v && v.indexOf(from) !== -1) attrEls[i].setAttribute(attr, v.split(from).join(to));
      });
    }
    if (document.title.indexOf(from) !== -1) document.title = document.title.split(from).join(to);
    var meta = document.querySelector('meta[name="description"]');
    if (meta && (meta.getAttribute('content') || '').indexOf(from) !== -1) meta.setAttribute('content', (meta.getAttribute('content') || '').split(from).join(to));
  }
  // ---------- UI ----------
  var style = document.createElement('style');
  style.textContent = '.t3e-hit{outline:2px dashed #7c3aed !important;outline-offset:2px;cursor:pointer !important}.t3e-hit:hover{outline-style:solid !important}#t3e-root{position:fixed;top:0;right:0;bottom:0;width:350px;max-width:92vw;z-index:2147483000;background:#fff;color:#111;font:14px/1.5 system-ui,sans-serif;box-shadow:-4px 0 24px rgba(0,0,0,.25);display:flex;flex-direction:column}#t3e-root *{box-sizing:border-box}#t3e-banner{position:fixed;top:0;left:0;right:0;z-index:2147483001;background:#7c3aed;color:#fff;padding:10px 16px;font:600 13.5px/1.45 system-ui,sans-serif;display:flex;gap:12px;align-items:center;justify-content:space-between}#t3e-banner a{color:#fff;text-decoration:underline}#t3e-root header{padding:14px 16px;border-bottom:1px solid #e5e7eb}#t3e-root h2{margin:0 0 4px;font-size:16px}#t3e-root .hint{color:#6b7280;font-size:12.5px}#t3e-list{overflow-y:auto;padding:8px}#t3e-list button.row{display:block;width:100%;text-align:left;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:9px 11px;margin:6px 0;cursor:pointer}#t3e-list button.row b{display:block;font-size:13.5px}#t3e-list button.row span{color:#6b7280;font-size:12.5px;word-break:break-word}#t3e-list button.row.changed{border-color:#7c3aed;background:#f5f3ff}.t3e-btn{background:#7c3aed;color:#fff;border:0;border-radius:8px;padding:9px 14px;font-weight:600;cursor:pointer}.t3e-btn.secondary{background:#e5e7eb;color:#111}.t3e-btn.danger{background:#b91c1c}#t3e-form{padding:14px 16px;overflow-y:auto}#t3e-form label{display:block;font-weight:600;margin:12px 0 4px;font-size:13px}#t3e-form input,#t3e-form textarea{width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:8px;font:inherit}#t3e-form .actions{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}.t3e-change{border:1px solid #e5e7eb;border-radius:8px;padding:9px 11px;margin:8px 0;font-size:13px}.t3e-change .from{color:#9ca3af;text-decoration:line-through;word-break:break-word}.t3e-change .to{color:#065f46;font-weight:600;word-break:break-word}.t3e-warnbox{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:8px;padding:10px 12px;font-size:13px;margin:10px 0}';
  document.head.appendChild(style);
  var root = document.createElement('div');
  root.id = 't3e-root';
  var banner = document.createElement('div');
  banner.id = 't3e-banner';
  banner.innerHTML = '<span>' + esc(S.warn) + '</span><span style="white-space:nowrap"><a href="' + EXIT_URL + '">' + esc(S.exit) + '</a></span>';
  document.body.appendChild(banner);
  document.body.appendChild(root);
  document.body.style.paddingTop = '54px';
  var targetsById = {};
  var selectedId = null;
  var view = 'list';
  function refreshHighlights() {
    document.querySelectorAll('.t3e-hit').forEach(function (el) { el.classList.remove('t3e-hit'); });
    targetsById = {};
    candidates.forEach(function (c) {
      var t = findTargets(c);
      targetsById[c.id] = t;
      t.els.forEach(function (el) { el.classList.add('t3e-hit'); el.setAttribute('data-t3e-candidate', c.id); });
    });
  }
  function changedCount() { return Object.keys(changes).length; }
  function render() {
    if (view === 'list') renderList();
    else if (view === 'form') renderForm();
    else if (view === 'confirm') renderConfirm();
    else if (view === 'status') renderStatus();
  }
  function headerHtml() {
    return '<header><h2>' + esc(S.panelTitle) + '</h2><div class="hint">' + esc(S.hint) + '</div>' +
      '<div style="margin-top:10px;display:flex;gap:8px;align-items:center"><button class="t3e-btn" id="t3e-finish">' + esc(S.finalize) + ' (' + changedCount() + ' ' + esc(S.changed) + ')</button>' +
      '<a href="' + EXIT_URL + '" style="color:#6b7280">' + esc(S.exit) + '</a></div></header>';
  }
  function renderList() {
    var html = headerHtml() + '<div id="t3e-list">';
    candidates.forEach(function (c) {
      var cur = currentOf(c);
      var shown = c.kind === 'image' ? (cur.url || '') : (lang === 'en' && cur.en ? cur.en : (cur.vi || cur.en || ''));
      html += '<button class="row' + (changes[c.id] ? ' changed' : '') + '" data-open="' + esc(c.id) + '"><b>' + esc(labelFor(c)) + '</b><span>' + esc(shown) + '</span></button>';
    });
    html += '</div>';
    root.innerHTML = html;
    root.querySelectorAll('[data-open]').forEach(function (btn) {
      btn.addEventListener('click', function () { selectedId = btn.getAttribute('data-open'); view = 'form'; render(); });
    });
    var fin = document.getElementById('t3e-finish');
    if (fin) fin.addEventListener('click', function () { view = 'confirm'; render(); });
  }
  function renderForm() {
    var c = candidates.filter(function (x) { return x.id === selectedId; })[0];
    if (!c) { view = 'list'; renderList(); return; }
    var cur = currentOf(c);
    var t = targetsById[c.id] || { els: [], head: false };
    var html = '<div id="t3e-form"><h2 style="margin:0 0 6px;font-size:16px">' + esc(labelFor(c)) + '</h2>';
    if (t.head && t.els.length === 0) html += '<div class="hint">' + esc(S.headNote) + '</div>';
    if (c.kind === 'image') {
      html += '<label>' + esc(S.imageUrl) + '</label><input id="t3e-f-url" value="' + esc(cur.url || '') + '">';
      if (cur.url) html += '<img src="' + esc(cur.url) + '" alt="" style="max-width:100%;margin-top:10px;border-radius:8px">';
    } else if (c.vi !== undefined && c.en !== undefined) {
      html += '<label>' + esc(S.valueVi) + '</label><textarea id="t3e-f-vi" rows="2">' + esc(cur.vi || '') + '</textarea>';
      html += '<label>' + esc(S.valueEn) + '</label><textarea id="t3e-f-en" rows="2">' + esc(cur.en || '') + '</textarea>';
    } else {
      html += '<label>' + esc(S.value) + '</label><textarea id="t3e-f-vi" rows="3">' + esc(cur.vi || cur.en || '') + '</textarea>';
    }
    html += '<div class="actions"><button class="t3e-btn" id="t3e-apply">' + esc(S.preview) + '</button><button class="t3e-btn secondary" id="t3e-back">' + esc(S.backToList) + '</button></div></div>';
    root.innerHTML = html;
    document.getElementById('t3e-back').addEventListener('click', function () { view = 'list'; render(); });
    document.getElementById('t3e-apply').addEventListener('click', function () {
      var entry = {};
      if (c.kind === 'image') {
        var url = document.getElementById('t3e-f-url').value.trim();
        if (url && url !== c.url) entry.url = url;
        var oldUrl = currentOf(c).url;
        targetsById[c.id] && targetsById[c.id].els.forEach(function (img) { img.setAttribute('src', url); });
        if (oldUrl && url) { /* src already swapped on matched images */ }
      } else {
        var viEl = document.getElementById('t3e-f-vi');
        var enEl = document.getElementById('t3e-f-en');
        var before = currentOf(c);
        if (viEl) { var nv = viEl.value; if (nv !== (c.vi !== undefined ? c.vi : c.en)) entry.vi = nv; replaceEverywhere(before.vi || before.en, nv); }
        if (enEl) { var ne = enEl.value; if (ne !== c.en) entry.en = ne; replaceEverywhere(before.en, ne); }
      }
      if (Object.keys(entry).length > 0) changes[c.id] = entry; else delete changes[c.id];
      persist();
      refreshHighlights();
      view = 'list';
      render();
    });
  }
  function changeEntries() {
    var out = [];
    candidates.forEach(function (c) {
      var ch = changes[c.id];
      if (!ch) return;
      out.push({ c: c, ch: ch });
    });
    return out;
  }
  function renderConfirm() {
    var entries = changeEntries();
    var html = '<div id="t3e-form"><h2 style="margin:0 0 6px;font-size:16px">' + esc(S.confirmTitle) + '</h2>';
    if (entries.length === 0) {
      html += '<p>' + esc(S.noChanges) + '</p>';
    } else {
      html += '<div class="t3e-warnbox">' + esc(S.confirmBody) + '</div>';
      entries.forEach(function (e) {
        var cur = { vi: e.c.vi, en: e.c.en, url: e.c.url };
        html += '<div class="t3e-change"><b>' + esc(labelFor(e.c)) + '</b>';
        ['vi', 'en', 'url'].forEach(function (k) {
          if (e.ch[k] !== undefined) html += '<div><span class="from">' + esc(cur[k] || '') + '</span> → <span class="to">' + esc(e.ch[k]) + '</span></div>';
        });
        html += '</div>';
      });
    }
    html += '<div class="actions"><button class="t3e-btn secondary" id="t3e-back2">' + esc(S.back) + '</button>' +
      (entries.length ? '<button class="t3e-btn danger" id="t3e-lock">' + esc(S.confirmLock) + '</button>' : '') + '</div></div>';
    root.innerHTML = html;
    document.getElementById('t3e-back2').addEventListener('click', function () { view = 'list'; render(); });
    var lock = document.getElementById('t3e-lock');
    if (lock) lock.addEventListener('click', submitFinalize);
  }
  var statusState = 'applying';
  function renderStatus() {
    var msg = statusState === 'done' ? S.done : statusState === 'failed' ? S.failed : S.applying;
    var html = '<div id="t3e-form"><h2 style="margin:0 0 8px;font-size:16px">' + esc(msg) + '</h2>';
    if (statusState === 'done') html += '<div class="actions"><a class="t3e-btn" href="' + EXIT_URL + '" style="text-decoration:none">' + esc(S.viewSite) + '</a></div>';
    html += '</div>';
    root.innerHTML = html;
  }
  function submitFinalize() {
    var payload = { changes: changeEntries().map(function (e) {
      var o = { id: e.c.id };
      if (e.ch.vi !== undefined) o.vi = e.ch.vi;
      if (e.ch.en !== undefined) o.en = e.ch.en;
      if (e.ch.url !== undefined) o.url = e.ch.url;
      return o;
    }) };
    view = 'status';
    statusState = 'applying';
    render();
    fetch(FINALIZE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 202) { pollStatus(); return; }
        statusState = 'failed';
        render();
      })
      .catch(function () { pollStatus(); });
  }
  function pollStatus() {
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      fetch(STATUS_URL, { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j.state === 'done' || j.state === 'failed') {
            clearInterval(timer);
            statusState = j.state;
            if (j.state === 'done') { try { sessionStorage.removeItem(storeKey); } catch (e) {} }
            render();
          } else if (tries > 90) {
            clearInterval(timer);
            statusState = 'failed';
            render();
          }
        })
        .catch(function () {});
    }, 2000);
  }
  // Freeze page interactions outside the editor: no navigation, no
  // form submits — the only way out is finalize or the exit link.
  document.addEventListener('click', function (ev) {
    if (inEditor(ev.target)) return;
    var el = ev.target;
    while (el && el !== document.body) {
      var cid = el.getAttribute && el.getAttribute('data-t3e-candidate');
      if (cid) {
        selectedId = cid;
        view = 'form';
        render();
        var t = targetsById[cid];
        if (t && t.els[0]) t.els[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
        break;
      }
      el = el.parentElement;
    }
    ev.preventDefault();
    ev.stopPropagation();
  }, true);
  document.addEventListener('submit', function (ev) { if (!inEditor(ev.target)) ev.preventDefault(); }, true);
  refreshHighlights();
  render();
})();
`;

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { firebaseConfig } from './config.js';
import { makeStore } from './store.js';

(function () {
  'use strict';
  // ---------- Utilities ----------
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
  const mondayOf = (s) => { const d = parse(s); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); return iso(d); };
  const TODAY = iso(new Date());
  const fmtD = (s) => parse(s).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' });
  const fmtDW = (s) => parse(s).toLocaleDateString('pl-PL', { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtLong = (s) => parse(s).toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' });
  const fmtN = (v, d = 1) => (v == null || isNaN(v)) ? '—' : Number(v).toLocaleString('pl-PL', { maximumFractionDigits: d });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const avg = (a) => { const v = a.filter(x => x != null && !isNaN(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN; };
  let toastT;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3200); }

  const TYPES = {
    gym: { name: 'Siłownia', c: 'var(--s-gym)' },
    run: { name: 'Bieg', c: 'var(--s-run)' },
    bike: { name: 'Rower', c: 'var(--s-bike)' },
    rest: { name: 'Regeneracja', c: 'var(--s-rest)' },
    other: { name: 'Inne', c: 'var(--s-rest)' },
  };
  const STATUS = { done: '✓ Wykonany', partial: '◐ Częściowo', missed: '✕ Pominięty', today: '● Dziś', planned: '○ Zaplanowany' };
  const MEALS = ['Śniadanie', 'II śniadanie', 'Obiad', 'Podwieczorek', 'Kolacja', 'Przekąska'];
  // Nutrition per 100 g: kcal, protein, fat, carbs
  const BASE_PRODUCTS = {
    'Płatki owsiane': [379, 13.2, 6.5, 60], 'Mleko 2%': [50, 3.4, 2, 4.8], 'Jajko kurze': [140, 12.5, 9.7, 0.6],
    'Chleb żytni razowy': [213, 5.9, 1.8, 45], 'Pierś z kurczaka': [98, 21.5, 1.3, 0], 'Ryż biały (ugotowany)': [130, 2.7, 0.3, 28],
    'Kasza gryczana (ugotowana)': [110, 3.4, 0.6, 22], 'Ziemniaki gotowane': [77, 1.9, 0.1, 17], 'Makaron pełnoziarnisty (ugotowany)': [124, 5.3, 0.5, 26],
    'Twaróg półtłusty': [133, 18.7, 4.7, 3.7], 'Skyr naturalny': [63, 11, 0.2, 4], 'Jogurt grecki 2%': [73, 10, 2, 3.6],
    'Banan': [97, 1, 0.3, 23], 'Jabłko': [52, 0.3, 0.2, 14], 'Borówki': [57, 0.7, 0.3, 14], 'Masło orzechowe': [588, 25, 50, 20],
    'Oliwa z oliwek': [884, 0, 100, 0], 'Łosoś': [201, 20, 13, 0], 'Wołowina chuda': [116, 21, 3.5, 0], 'Ser gouda': [356, 25, 27, 2],
    'Szynka z indyka': [104, 19, 2, 2], 'Pomidor': [18, 0.9, 0.2, 3.9], 'Ogórek': [15, 0.7, 0.1, 3.6], 'Awokado': [160, 2, 15, 9],
    'Orzechy włoskie': [654, 15, 65, 14], 'Odżywka białkowa': [400, 75, 7, 9], 'Hummus': [166, 8, 9.6, 14], 'Pierogi ruskie': [190, 6, 5, 30],
    'Pizza margherita': [250, 11, 9, 31], 'Piwo jasne': [43, 0.5, 0, 3.6], 'Baton proteinowy': [360, 30, 12, 35], 'Tort': [350, 5, 18, 45],
    'Brokuły': [34, 2.8, 0.4, 7], 'Sałata': [15, 1.4, 0.2, 2.9],
  };

  // ---------- State ----------
  const S = {
    db: null, me: null, role: null, access: null, canWrite: true, connected: false, unsubs: [],
    garmin: null, acts: null, targets: null,
    workouts: new Map(), food: new Map(), comments: [],
    range: 30, weekStart: mondayOf(TODAY), foodDate: TODAY,
    sel: null, editing: false, draft: null, exSel: null, confirmDel: false, confirmSample: false,
  };
  const T = () => Object.assign({ kcal: 2200, protein: 160, fat: 70, carbs: 240, water: 3, weightGoal: null, fatGoal: null, goalDate: null }, S.targets || {});

  // ---------- Writes: one at a time per document, latest wins ----------
  const queue = new Map();
  function save(path, data, delay) {
    if (!S.db) { toast('Baza danych jest niedostępna. Zmiana nie została zapisana.'); return; }
    let q = queue.get(path); if (!q) { q = { busy: false, next: null, timer: null }; queue.set(path, q); }
    q.next = data; clearTimeout(q.timer); q.timer = null;
    if (delay) q.timer = setTimeout(() => { q.timer = null; if (!q.busy) flush(path, q); }, delay);
    else if (!q.busy) flush(path, q);
  }
  async function flush(path, q) {
    q.busy = true;
    while (q.next && !q.timer) {
      const d = q.next; q.next = null;
      try { await S.db.doc(path).set(d); }
      catch (e) { handleWriteError(e); }
    }
    q.busy = false;
  }
  const pendingWrite = (path) => { const q = queue.get(path); return !!(q && (q.busy || q.next || q.timer)); };
  async function remove(path) {
    try { await S.db.doc(path).delete(); } catch (e) { handleWriteError(e); }
  }
  function handleWriteError(e) {
    if (e && e.code === 'permission-denied') { S.canWrite = false; renderAll(); toast('Brak uprawnień do zapisu. Zmiany nie są zapisywane.'); }
    else if (e && e.code === 'resource-exhausted') toast('Przekroczony dzienny limit bazy danych. Spróbuj jutro.');
    else toast('Nie udało się zapisać. Sprawdź połączenie i spróbuj ponownie.');
  }

  // ---------- Banners, header ----------
  $('today-label').textContent = fmtLong(TODAY);
  const initials = (name) => (name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '·';
  function renderHeader() {
    const sync = $('sync');
    const name = S.access?.athleteName || 'Dziennik treningowy';
    $('athlete-name').textContent = name; $('athlete-initials').textContent = initials(S.access?.athleteName || 'T L');
    if (!S.connected) { sync.className = 'dot-off'; sync.textContent = 'Łączenie z bazą danych…'; }
    else if (S.garmin && S.garmin.updatedAt) { const d = new Date(S.garmin.updatedAt); const stale = (Date.now() - d) > 36 * 3600e3; sync.className = stale ? 'dot-off' : 'dot-ok'; sync.textContent = `Garmin: ${d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}`; }
    else { sync.className = 'dot-off'; sync.textContent = 'Garmin: brak danych'; }
    $('role').textContent = S.connected ? (S.role === 'athlete' ? 'Widok: zawodnik' : 'Widok: trener') + (S.canWrite ? '' : ' · tylko podgląd') : '';
    $('signout').title = S.me?.email || '';
  }
  function renderBanners() {
    let html = '';
    if (S.garmin?.updatedAt) {
      const days = Math.floor((Date.now() - new Date(S.garmin.updatedAt)) / 86400e3);
      if (days >= 2) html += `<div class="banner warn"><span>Dane z Garmin nie były aktualizowane od ${days} dni. Sprawdź synchronizację w zakładce Actions na GitHub.</span></div>`;
    }
    $('banners').innerHTML = html;
  }

  // ---------- Chart helpers ----------
  const NS = 'http://www.w3.org/2000/svg';
  const tip = $('tip');
  function el(tag, attrs, parent) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
  function niceTicks(min, max, n) {
    const span = max - min || 1; const step0 = span / n; const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map(s => s * mag).find(s => s >= step0);
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step; const t = [];
    for (let v = lo; v <= hi + step / 2; v += step) t.push(Math.round(v * 1000) / 1000);
    return t;
  }
  function showTip(html, ev) {
    tip.innerHTML = html; tip.classList.add('on');
    const w = tip.offsetWidth, h = tip.offsetHeight; let x = ev.clientX + 14, y = ev.clientY - h - 12;
    if (x + w > window.innerWidth - 8) x = ev.clientX - w - 14; if (y < 8) y = ev.clientY + 16;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  const hideTip = () => tip.classList.remove('on');
  function roundedBar(x, y, w, h, r, top) {
    if (h <= 0) return 'M0,0';
    r = Math.min(r, w / 2, h);
    if (top) return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
    return `M${x},${y}H${x + w}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x + r}Q${x},${y + h} ${x},${y + h - r}Z`;
  }
  function emptyChart(host, msg, h) { host.innerHTML = `<div class="empty" style="min-height:${h || 120}px;display:grid;place-items:center">${esc(msg)}</div>`; }

  function lineChart(host, o) {
    const data = (o.data || []).filter(p => p.v != null && !isNaN(p.v));
    if (data.length < 2) return emptyChart(host, o.empty || 'Brak danych', (o.h || 200) - 20);
    host.innerHTML = '';
    const W = host.clientWidth || 400, H = o.h || 210, m = { t: 12, r: 14, b: 26, l: o.l || 38 };
    const vals = data.map(p => p.v).concat(o.target != null ? [o.target] : []).concat(o.band || []);
    let mn = Math.min(...vals), mx = Math.max(...vals); const padv = (mx - mn) * 0.12 || 1; mn -= padv; mx += padv;
    const ticks = niceTicks(mn, mx, 4); mn = ticks[0]; mx = ticks[ticks.length - 1];
    const x = (i) => m.l + (i / (data.length - 1)) * (W - m.l - m.r);
    const y = (v) => m.t + (1 - (v - mn) / (mx - mn)) * (H - m.t - m.b);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': o.label }, host);
    if (o.band) el('rect', { x: m.l, y: y(o.band[1]), width: W - m.l - m.r, height: y(o.band[0]) - y(o.band[1]), fill: 'var(--accent-soft)' }, svg);
    ticks.forEach(t => { el('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: 'gridline' }, svg); el('text', { x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'num' }, svg).textContent = fmtN(t); });
    const nx = Math.max(2, Math.min(6, Math.floor((W - m.l - m.r) / 90), data.length));
    for (let k = 0; k < nx; k++) { const i = Math.round(k * (data.length - 1) / (nx - 1)); el('text', { x: x(i), y: H - 6, 'text-anchor': k === 0 ? 'start' : k === nx - 1 ? 'end' : 'middle' }, svg).textContent = fmtD(data[i].d); }
    if (o.target != null) el('line', { x1: m.l, x2: W - m.r, y1: y(o.target), y2: y(o.target), stroke: 'var(--muted)', 'stroke-width': 1.5, 'stroke-dasharray': '5 4' }, svg);
    const pts = data.map((p, i) => `${x(i)},${y(p.v)}`);
    el('path', { d: `M${m.l},${H - m.b}L${pts.join('L')}L${x(data.length - 1)},${H - m.b}Z`, fill: o.color, opacity: 0.08 }, svg);
    el('path', { d: `M${pts.join('L')}`, fill: 'none', stroke: o.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    if (o.markers) data.forEach((p, i) => el('circle', { cx: x(i), cy: y(p.v), r: 4, fill: o.color, stroke: 'var(--surface)', 'stroke-width': 2 }, svg));
    const li = data.length - 1;
    el('circle', { cx: x(li), cy: y(data[li].v), r: 4.5, fill: o.color, stroke: 'var(--surface)', 'stroke-width': 2 }, svg);
    const xh = el('line', { y1: m.t, y2: H - m.b, class: 'xhair', visibility: 'hidden' }, svg);
    const dot = el('circle', { r: 5, fill: o.color, stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' }, svg);
    const hit = el('rect', { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: 'transparent' }, svg);
    hit.addEventListener('pointermove', (ev) => {
      const r = svg.getBoundingClientRect(); const px = (ev.clientX - r.left) * (W / r.width);
      const i = Math.max(0, Math.min(li, Math.round((px - m.l) / (W - m.l - m.r) * li)));
      xh.setAttribute('x1', x(i)); xh.setAttribute('x2', x(i)); xh.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(data[i].v)); dot.setAttribute('visibility', 'visible');
      showTip(`<b>${esc(fmtDW(data[i].d))}</b><div class="row"><span><i style="background:${o.color}"></i>${esc(o.name)}</span><span>${fmtN(data[i].v)} ${esc(o.unit || '')}</span></div>${data[i].extra ? `<div class="row" style="opacity:.8"><span>${esc(data[i].extra)}</span></div>` : ''}`, ev);
    });
    hit.addEventListener('pointerleave', () => { xh.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); hideTip(); });
  }

  function spark(host, data, color) {
    host.innerHTML = ''; const v = data.map(p => p.v).filter(x => x != null); if (v.length < 2) return;
    const W = host.clientWidth || 140, H = 30;
    const mn = Math.min(...v), mx = Math.max(...v); const x = i => 2 + i / (v.length - 1) * (W - 6); const y = d => 3 + (1 - (d - mn) / (mx - mn || 1)) * (H - 6);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H, 'aria-hidden': 'true' }, host);
    const pts = v.map((d, i) => `${x(i)},${y(d)}`);
    el('path', { d: `M${x(0)},${H}L${pts.join('L')}L${x(v.length - 1)},${H}Z`, fill: color, opacity: 0.1 }, svg);
    el('path', { d: 'M' + pts.join('L'), fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }, svg);
    el('circle', { cx: x(v.length - 1), cy: y(v[v.length - 1]), r: 3, fill: color }, svg);
  }

  function stackedBars(host, o) {
    if (!o.data || !o.data.length) return emptyChart(host, o.empty || 'Brak danych', (o.h || 220) - 20);
    host.innerHTML = '';
    const W = host.clientWidth || 400, H = o.h || 220, m = { t: 12, r: 8, b: 26, l: 44 };
    const totals = o.data.map(d => o.keys.reduce((s, k) => s + (d[k.key] || 0), 0));
    const ticks = niceTicks(0, Math.max(...totals, o.target || 0) * 1.05, 4); const mx = ticks[ticks.length - 1];
    const bw = (W - m.l - m.r) / o.data.length; const w = Math.max(4, Math.min(34, bw * 0.62));
    const y = v => m.t + (1 - v / mx) * (H - m.t - m.b);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': o.label }, host);
    ticks.forEach(t => { el('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: t === 0 ? 'baseline' : 'gridline' }, svg); el('text', { x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'num' }, svg).textContent = fmtN(t); });
    if (o.target) el('line', { x1: m.l, x2: W - m.r, y1: y(o.target), y2: y(o.target), stroke: 'var(--muted)', 'stroke-width': 1.5, 'stroke-dasharray': '5 4' }, svg);
    const every = Math.ceil(o.data.length / Math.max(2, Math.floor((W - m.l) / 56)));
    o.data.forEach((d, i) => {
      const cx = m.l + bw * i + bw / 2, x0 = cx - w / 2; let acc = 0;
      const g = el('g', {}, svg);
      const present = o.keys.filter(k => (d[k.key] || 0) > 0); const topKey = present[present.length - 1];
      o.keys.forEach((k) => {
        const v = d[k.key] || 0; if (v <= 0) return;
        const yTop = y(acc + v), yBot = y(acc) - (acc > 0 ? 2 : 0);
        el('path', { d: roundedBar(x0, yTop, w, Math.max(0, yBot - yTop), 4, k === topKey), fill: k.color, opacity: d.partial ? 0.55 : 1 }, g);
        acc += v;
      });
      if (i % every === 0 || i === o.data.length - 1) el('text', { x: cx, y: H - 6, 'text-anchor': 'middle' }, svg).textContent = d.label;
      const hit = el('rect', { x: m.l + bw * i, y: m.t, width: bw, height: H - m.t - m.b, fill: 'transparent' }, svg);
      hit.addEventListener('pointermove', (ev) => {
        g.setAttribute('opacity', 0.82);
        showTip(`<b>${esc(o.title(d))}</b>` + o.keys.slice().reverse().map(k => `<div class="row"><span><i style="background:${k.color}"></i>${esc(k.name)}</span><span>${fmtN(d[k.key] || 0)} ${esc(o.unit)}</span></div>`).join('') + (o.keys.length > 1 ? `<div class="row" style="margin-top:3px;opacity:.8"><span>Razem</span><span>${fmtN(totals[i])} ${esc(o.unit)}</span></div>` : ''), ev);
      });
      hit.addEventListener('pointerleave', () => { g.removeAttribute('opacity'); hideTip(); });
    });
  }

  function divergingBars(host, o) {
    if (!o.data.length) return emptyChart(host, o.empty, 180);
    host.innerHTML = '';
    const W = host.clientWidth || 400, H = o.h || 220, m = { t: 12, r: 8, b: 26, l: 50 };
    const ext = Math.max(200, ...o.data.map(d => Math.abs(d.v))) * 1.1;
    const ticks = niceTicks(-ext, ext, 4); const mn = ticks[0], mx = ticks[ticks.length - 1];
    const y = v => m.t + (1 - (v - mn) / (mx - mn)) * (H - m.t - m.b);
    const bw = (W - m.l - m.r) / o.data.length; const w = Math.max(4, Math.min(26, bw * 0.6));
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': o.label }, host);
    ticks.forEach(t => { el('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: t === 0 ? 'baseline' : 'gridline' }, svg); el('text', { x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'num' }, svg).textContent = (t > 0 ? '+' : '') + fmtN(t); });
    const every = Math.ceil(o.data.length / Math.max(2, Math.floor((W - m.l) / 56)));
    o.data.forEach((d, i) => {
      const cx = m.l + bw * i + bw / 2, x0 = cx - w / 2; const pos = d.v > 0;
      const yA = pos ? y(d.v) : y(0), h = Math.abs(y(d.v) - y(0));
      const bar = el('path', { d: roundedBar(x0, yA, w, h, 4, pos), fill: pos ? 'var(--div-pos)' : 'var(--div-neg)' }, svg);
      if (i % every === 0 || i === o.data.length - 1) el('text', { x: cx, y: H - 6, 'text-anchor': 'middle' }, svg).textContent = fmtD(d.date);
      const hit = el('rect', { x: m.l + bw * i, y: m.t, width: bw, height: H - m.t - m.b, fill: 'transparent' }, svg);
      hit.addEventListener('pointermove', (ev) => { bar.setAttribute('opacity', 0.8); showTip(`<b>${esc(fmtDW(d.date))}</b><div class="row"><span>Zjedzone</span><span>${fmtN(d.eaten, 0)} kcal</span></div><div class="row"><span>Spalone</span><span>${fmtN(d.burned, 0)} kcal</span></div><div class="row" style="margin-top:3px"><span>${pos ? 'Nadwyżka' : 'Deficyt'}</span><span>${fmtN(Math.abs(d.v), 0)} kcal</span></div>`, ev); });
      hit.addEventListener('pointerleave', () => { bar.removeAttribute('opacity'); hideTip(); });
      hit.style.cursor = 'pointer';
      hit.addEventListener('click', () => { S.foodDate = d.date; renderFood(); });
    });
  }

  // ---------- Garmin derived ----------
  const days = () => (S.garmin?.days || []).slice().sort((a, b) => a.date < b.date ? -1 : 1);
  const series = (key, n) => days().slice(-n).map(d => ({ d: d.date, v: d[key] }));

  const HRV_STATUS = { BALANCED: 'Zrównoważony', UNBALANCED: 'Niezrównoważony', LOW: 'Niski', POOR: 'Słaby' };
  function hrvBand() { const d = days().filter(x => x.hrvLow != null && x.hrvHigh != null).pop(); return d ? [d.hrvLow, d.hrvHigh] : null; }
  function renderSummary() {
    const ds = days(); const t = T();
    const host = $('kpis');
    const workoutsPast = [...S.workouts.values()].filter(w => w.date < TODAY && w.date >= addDays(TODAY, -28));
    const doneCnt = workoutsPast.filter(w => wStatus(w) === 'done').length;
    const tiles = [];
    if (ds.length) {
      const w = ds.filter(d => d.weight != null); const wNow = avg(w.slice(-3).map(d => d.weight)), wWeek = avg(w.slice(-10, -7).map(d => d.weight));
      const rhrNow = avg(ds.slice(-7).map(d => d.rhr)), rhr30 = avg(ds.slice(-37, -30).map(d => d.rhr));
      const sl = ds.slice(-7).map(d => (d.sleepDeep || 0) + (d.sleepRem || 0) + (d.sleepLight || 0)).filter(h => h > 0); const sa = avg(sl);
      const hh = Math.floor(sa), mm = Math.round((sa - hh) * 60);
      const dW = wWeek - wNow, dR = rhr30 - rhrNow;
      if (!isNaN(wNow)) tiles.push({ label: 'Waga (śr. 3 dni)', value: fmtN(wNow), unit: 'kg', delta: isNaN(dW) ? '' : `<span class="${dW >= 0 ? 'good' : 'bad'}">${dW >= 0 ? '▼' : '▲'} ${fmtN(Math.abs(dW))} kg</span> w tydzień`, spark: series('weight', 30) });
      if (!isNaN(rhrNow)) tiles.push({ label: 'Tętno spoczynkowe', value: Math.round(rhrNow), unit: 'ud./min', delta: isNaN(dR) ? '' : `<span class="${dR >= 0 ? 'good' : 'bad'}">${dR >= 0 ? '▼' : '▲'} ${Math.round(Math.abs(dR))}</span> w 30 dni`, spark: series('rhr', 30) });
      if (!isNaN(sa)) tiles.push({ label: 'Sen, śr. 7 nocy', value: `${hh}<small>h</small> ${pad(mm)}`, unit: 'min', delta: ds[ds.length - 1].sleepScore ? `Ocena snu ${ds[ds.length - 1].sleepScore}/100` : '' });
      const hrvDay = ds.filter(d => d.hrv != null).pop(); const band = hrvBand();
      if (hrvDay) tiles.push({ label: 'HRV w nocy', value: hrvDay.hrv, unit: 'ms', delta: !band ? (hrvDay.hrvStatus ? esc(HRV_STATUS[hrvDay.hrvStatus] || hrvDay.hrvStatus) : '') : (hrvDay.hrv >= band[0] && hrvDay.hrv <= band[1] ? `<span class="good">✓</span> W normie ${band[0]}–${band[1]}` : `<span class="bad">!</span> Poza normą ${band[0]}–${band[1]}`), spark: series('hrv', 30) });
      if (S.garmin.vo2max) tiles.push({ label: 'VO2 max', value: S.garmin.vo2max, unit: '', delta: 'wg zegarka Garmin' });
    }
    tiles.push({ label: 'Treningi, 4 tygodnie', value: `${doneCnt}<small>z</small> ${workoutsPast.length}`, unit: '', delta: workoutsPast.length ? `${Math.round(doneCnt / workoutsPast.length * 100)}% planu wykonane` : 'Brak treningów w planie' });
    host.innerHTML = tiles.map((k, i) => `
      <div class="kpi"><div class="eyebrow">${k.label}</div>
        <div class="value">${k.value}${k.unit ? `<small>${k.unit}</small>` : ''}</div>
        <div class="delta">${k.delta}</div>${k.spark ? `<div class="spark" id="spark-${i}"></div>` : ''}</div>`).join('');
    tiles.forEach((k, i) => { if (k.spark) spark($('spark-' + i), k.spark, 'var(--s-run)'); });
    const goalTxt = (v, u) => v != null ? `Cel ${fmtN(v)} ${u}${t.goalDate ? ' do ' + fmtD(t.goalDate) : ''}` : 'Cel nieustalony';
    $('lg-weight').textContent = goalTxt(t.weightGoal, 'kg'); $('lg-fat').textContent = goalTxt(t.fatGoal, '%');
    const emptyG = 'Brak danych z Garmin. Pojawią się po pierwszym imporcie.';
    lineChart($('chart-weight'), { data: series('weight', S.range), target: t.weightGoal, color: 'var(--s-run)', name: 'Waga', unit: 'kg', label: 'Wykres wagi', empty: emptyG });
    lineChart($('chart-fat'), { data: series('fat', S.range), target: t.fatGoal, color: 'var(--s-gym)', name: 'Tłuszcz', unit: '%', label: 'Wykres tkanki tłuszczowej', empty: emptyG });
  }

  function renderGarmin() {
    const emptyG = 'Brak danych z Garmin. Pojawią się po pierwszym imporcie.';
    const band = hrvBand(); $('lg-hrv-wrap').hidden = !band; if (band) $('lg-hrv').textContent = `Twoja norma ${band[0]}–${band[1]}`;
    lineChart($('chart-hrv'), { data: series('hrv', S.range), band, color: 'var(--s-run)', name: 'HRV', unit: 'ms', h: 180, label: 'HRV w nocy', empty: emptyG });
    lineChart($('chart-rhr'), { data: series('rhr', S.range), color: 'var(--s-run)', name: 'Tętno spoczynkowe', unit: 'ud./min', h: 180, label: 'Tętno spoczynkowe', empty: emptyG });
    lineChart($('chart-bb'), { data: series('bb', S.range), color: 'var(--s-run)', name: 'Body Battery', unit: '', h: 180, label: 'Body Battery rano', empty: emptyG });
    const weeks = (S.garmin?.weeks || []).map((w, i, a) => ({ ...w, label: fmtD(w.start), partial: i === a.length - 1 && addDays(w.start, 6) >= TODAY }));
    stackedBars($('chart-volume'), { data: weeks, keys: [{ key: 'gym', name: 'Siłownia', color: 'var(--s-gym)' }, { key: 'bike', name: 'Rower', color: 'var(--s-bike)' }, { key: 'run', name: 'Bieg', color: 'var(--s-run)' }], unit: 'min', title: d => `Tydzień od ${fmtD(d.start)}${d.partial ? ' (trwa)' : ''}`, label: 'Czas treningu w tygodniu', empty: emptyG });
    stackedBars($('chart-steps'), { data: days().slice(-14).map(d => ({ label: fmtD(d.date), date: d.date, v: d.steps })), keys: [{ key: 'v', name: 'Kroki', color: 'var(--s-run)' }], unit: '', target: 10000, title: d => fmtDW(d.date), label: 'Kroki dziennie', empty: emptyG });
    stackedBars($('chart-sleep'), { data: days().slice(-14).map(d => ({ label: fmtD(d.date), date: d.date, deep: d.sleepDeep, rem: d.sleepRem, light: d.sleepLight })), keys: [{ key: 'deep', name: 'Głęboki', color: 'var(--sleep-deep)' }, { key: 'rem', name: 'REM', color: 'var(--sleep-rem)' }, { key: 'light', name: 'Płytki', color: 'var(--sleep-light)' }], unit: 'h', title: d => 'Noc na ' + fmtDW(d.date), label: 'Fazy snu', h: 200, empty: emptyG });
    const items = (S.acts?.items || []).slice().sort((a, b) => a.date < b.date ? 1 : -1);
    $('activities').innerHTML = items.length ? items.map(a => `<tr><td class="nowrap">${esc(fmtDW(a.date))}</td><td><span class="type"><i style="background:${(TYPES[a.type] || TYPES.rest).c}"></i>${esc(a.title)}</span></td>
      <td class="r nowrap">${a.distanceKm ? fmtN(a.distanceKm, 2) + ' km' : '<span class="muted">—</span>'}</td><td class="r">${esc(a.duration)}</td>
      <td class="r nowrap">${a.pace ? esc(a.pace) : '<span class="muted">—</span>'}</td><td class="r">${a.avgHr ?? '—'}</td><td class="r">${a.maxHr ?? '—'}</td>
      <td class="r"><span class="te">${fmtN(a.te)}</span></td><td class="r">${fmtN(a.kcal, 0)}</td></tr>`).join('')
      : `<tr><td colspan="9"><div class="empty">Brak aktywności. Pojawią się po imporcie z Garmin Connect.</div></td></tr>`;
  }

  // ---------- Training plan ----------
  function allSets(w) { return (w.exercises || []).flatMap(e => e.sets || []); }
  function wStatus(w) {
    if (w.done) return 'done';
    if (allSets(w).some(s => s.done)) return 'partial';
    if (w.date < TODAY) return 'missed';
    if (w.date === TODAY) return 'today';
    return 'planned';
  }
  const planTxt = (s) => `${s.reps ?? '—'} × ${s.kg ? fmtN(s.kg) + ' kg' : 'masa ciała'}`;

  function renderWeek() {
    const ws = S.weekStart; const we = addDays(ws, 6);
    $('wk-label').textContent = `${fmtD(ws)} – ${fmtD(we)}`;
    let html = '';
    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i);
      const list = [...S.workouts.entries()].filter(([, w]) => w.date === d).sort((a, b) => (a[1].order || 0) - (b[1].order || 0) || String(a[1].title).localeCompare(b[1].title));
      html += `<div class="day${d === TODAY ? ' is-today' : ''}"><div class="dh"><span class="dname">${esc(parse(d).toLocaleDateString('pl-PL', { weekday: 'short' }))}</span><span class="ddate">${esc(fmtD(d))}</span></div>`;
      list.forEach(([id, w]) => {
        const st = wStatus(w); const t = TYPES[w.type] || TYPES.rest;
        const nEx = (w.exercises || []).length;
        html += `<button type="button" class="wk" data-wid="${esc(id)}" aria-pressed="${S.sel === id}">
          <span class="type wtype"><i style="background:${t.c}"></i>${t.name}${nEx ? ` · ${nEx} ćw.` : ''}</span>
          <span class="wt">${esc(w.title || 'Trening')}</span>
          <span><span class="pill ${st}">${STATUS[st]}</span></span></button>`;
      });
      if (S.canWrite && S.connected) html += `<button type="button" class="add-day" data-add="${d}">+ Dodaj trening</button>`;
      html += `</div>`;
    }
    $('week').innerHTML = html;
  }

  function exVolume(e) { return (e.sets || []).filter(s => s.done).reduce((s, x) => s + (Number(x.aReps) || 0) * (Number(x.aKg) || 0), 0); }

  function renderDetail() {
    const host = $('wk-detail');
    const active = document.activeElement;
    if (host.contains(active) && active.matches('input[type="text"], input[type="number"], textarea, input:not([type])') && !S.forceDetail) { S.detailDirty = true; return; }
    S.forceDetail = false; S.detailDirty = false;
    const focusId = host.contains(active) ? active.id : null;
    const w = S.sel ? (S.editing ? S.draft : S.workouts.get(S.sel)) : null;
    if (!w) {
      host.innerHTML = `<div class="empty">${S.workouts.size ? 'Wybierz trening z kalendarza powyżej, aby zobaczyć ćwiczenia i wpisać wykonanie.' : 'Plan jest pusty. Trener dodaje treningi przyciskiem „+ Dodaj trening” w wybranym dniu.'}</div>`;
      return;
    }
    host.innerHTML = S.editing ? editHTML(w) : viewHTML(w);
    if (focusId && $(focusId)) $(focusId).focus();
  }

  function viewHTML(w) {
    const st = wStatus(w); const t = TYPES[w.type] || TYPES.rest; const ro = !S.canWrite ? 'disabled' : '';
    let h = `<div class="detail">
      <div class="detail-head"><div><div class="eyebrow">${esc(fmtLong(w.date))} · ${t.name}</div><h3>${esc(w.title || 'Trening')}</h3></div>
        <div class="detail-actions"><span class="pill ${st}" style="align-self:center">${STATUS[st]}</span>${S.canWrite ? `<button class="btn ghost sm" type="button" data-act="edit">Edytuj plan</button>` : ''}</div></div>`;
    if (w.target || w.notes) h += `<dl class="kv">${w.target ? `<dt>Cel</dt><dd>${esc(w.target)}</dd>` : ''}${w.notes ? `<dt>Uwagi trenera</dt><dd>${esc(w.notes)}</dd>` : ''}</dl>`;
    (w.exercises || []).forEach((e, i) => {
      const sets = e.sets || []; const nd = sets.filter(s => s.done).length; const vol = exVolume(e);
      h += `<div class="exercise"><div class="ex-head"><div><span class="ex-name">${esc(e.name)}</span>${e.note ? ` <span class="ex-note">· ${esc(e.note)}</span>` : ''}</div>
        <span class="ex-sum">${nd}/${sets.length} serii${vol ? ` · objętość ${fmtN(vol, 0)} kg` : ''}</span></div>
        <div class="table-wrap"><table class="sets"><thead><tr><th>Seria</th><th>Plan</th><th>Wykonano: powt.</th><th>kg</th><th class="c">Zrobione</th></tr></thead><tbody>`;
      sets.forEach((s, j) => {
        const k = `${i}-${j}`;
        h += `<tr class="${s.done ? 'is-done' : ''}"><td>${j + 1}</td><td class="nowrap">${esc(planTxt(s))}</td>
          <td><input type="number" min="0" step="1" id="ar-${k}" data-set="${k}" data-f="aReps" value="${s.aReps ?? ''}" placeholder="${s.reps ?? ''}" aria-label="Wykonane powtórzenia, seria ${j + 1}" ${ro}></td>
          <td><input type="number" min="0" step="0.5" id="ak-${k}" data-set="${k}" data-f="aKg" value="${s.aKg ?? ''}" placeholder="${s.kg ?? ''}" aria-label="Wykonany ciężar, seria ${j + 1}" ${ro}></td>
          <td class="c"><input type="checkbox" id="ad-${k}" data-set="${k}" data-f="done" ${s.done ? 'checked' : ''} aria-label="Seria ${j + 1} zrobiona" ${ro}></td></tr>`;
      });
      h += `</tbody></table></div></div>`;
    });
    if (!(w.exercises || []).length && !w.target) h += `<div class="empty">Ten trening nie ma jeszcze ćwiczeń.${S.canWrite ? ' Kliknij „Edytuj plan”, aby je dodać.' : ''}</div>`;
    h += `<div class="feedback">
        <label class="field">Wynik i odczucia zawodnika <textarea id="fb-result" data-fb="result" placeholder="np. 8,3 km, 5:55/km, tętno 141. Ostatnia seria ciężko." ${ro}>${esc(w.result || '')}</textarea></label>
        <div style="display:grid;gap:8px">
          <label class="field">Zmęczenie (RPE 1–10) <select id="fb-rpe" data-fb="rpe" ${ro}><option value="">—</option>${[1,2,3,4,5,6,7,8,9,10].map(n => `<option ${w.rpe == n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          ${S.canWrite ? `<button class="btn ${w.done ? 'ghost' : ''}" type="button" data-act="done">${w.done ? 'Cofnij wykonanie' : 'Oznacz jako wykonany'}</button>` : ''}
        </div></div></div>`;
    return h;
  }

  function editHTML(w) {
    const knownEx = [...new Set([...S.workouts.values()].flatMap(x => (x.exercises || []).map(e => e.name)))].sort();
    let h = `<div class="detail">
      <div class="detail-head"><div><div class="eyebrow">Edycja planu</div><h3>${esc(w.title || 'Trening')}</h3></div></div>
      <div class="form-row">
        <label class="field" style="flex:1 1 220px">Nazwa <input id="ed-title" data-ed="title" value="${esc(w.title || '')}"></label>
        <label class="field">Data <input id="ed-date" type="date" data-ed="date" value="${esc(w.date)}"></label>
        <label class="field">Rodzaj <select id="ed-type" data-ed="type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${w.type === k ? 'selected' : ''}>${v.name}</option>`).join('')}</select></label>
      </div>
      <label class="field">Cel (np. dystans, tempo, strefa tętna) <input id="ed-target" data-ed="target" value="${esc(w.target || '')}"></label>
      <label class="field">Uwagi trenera <textarea id="ed-notes" data-ed="notes">${esc(w.notes || '')}</textarea></label>`;
    (w.exercises || []).forEach((e, i) => {
      h += `<div class="exercise"><div class="form-row">
          <label class="field" style="flex:1 1 200px">Ćwiczenie <input id="ee-name-${i}" data-ex="${i}" data-f="name" value="${esc(e.name)}" list="ex-names"></label>
          <label class="field" style="flex:1 1 200px">Wskazówki (tempo, przerwa) <input id="ee-note-${i}" data-ex="${i}" data-f="note" value="${esc(e.note || '')}"></label>
          <span style="display:inline-flex;gap:2px">
            <button class="iconbtn" type="button" data-exmove="${i}" data-dir="-1" aria-label="Przesuń wyżej" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="iconbtn" type="button" data-exmove="${i}" data-dir="1" aria-label="Przesuń niżej" ${i === w.exercises.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="iconbtn" type="button" data-exdel="${i}" aria-label="Usuń ćwiczenie">×</button></span>
        </div>
        <div class="table-wrap"><table class="sets"><thead><tr><th>Seria</th><th>Powtórzenia</th><th>Ciężar, kg</th><th></th></tr></thead><tbody>`;
      (e.sets || []).forEach((s, j) => {
        h += `<tr><td>${j + 1}</td><td><input type="number" min="0" id="es-r-${i}-${j}" data-es="${i}-${j}" data-f="reps" value="${s.reps ?? ''}" aria-label="Powtórzenia, seria ${j + 1}"></td>
          <td><input type="number" min="0" step="0.5" id="es-k-${i}-${j}" data-es="${i}-${j}" data-f="kg" value="${s.kg ?? ''}" placeholder="0 = masa ciała" aria-label="Ciężar, seria ${j + 1}"></td>
          <td><button class="iconbtn" type="button" data-setdel="${i}-${j}" aria-label="Usuń serię">×</button></td></tr>`;
      });
      h += `</tbody></table></div><div><button class="btn ghost sm" type="button" data-setadd="${i}">+ Seria</button></div></div>`;
    });
    h += `<div class="exercise" style="background:var(--surface-2)"><div class="eyebrow">Nowe ćwiczenie</div><div class="form-row">
        <label class="field" style="flex:1 1 220px">Nazwa <input id="nx-name" list="ex-names" placeholder="np. Przysiad ze sztangą"></label>
        <label class="field">Serie <input id="nx-sets" type="number" min="1" value="3"></label>
        <label class="field">Powtórzenia <input id="nx-reps" type="number" min="0" value="10"></label>
        <label class="field">Ciężar, kg <input id="nx-kg" type="number" min="0" step="0.5" placeholder="0"></label>
        <button class="btn ghost" type="button" data-act="addex">Dodaj ćwiczenie</button></div>
        <datalist id="ex-names">${knownEx.map(n => `<option value="${esc(n)}">`).join('')}</datalist></div>
      <div class="form-row" style="justify-content:space-between">
        <span style="display:inline-flex;gap:8px"><button class="btn" type="button" data-act="save">Zapisz plan</button><button class="btn ghost" type="button" data-act="cancel">Anuluj</button></span>
        <button class="btn danger ${S.confirmDel ? 'armed' : ''}" type="button" data-act="delete">${S.confirmDel ? 'Na pewno usunąć trening?' : 'Usuń trening'}</button></div></div>`;
    return h;
  }

  function mutateSel(fn, opts = {}) {
    const w = clone(S.workouts.get(S.sel)); if (!w) return;
    fn(w); w.updatedAt = new Date().toISOString(); S.workouts.set(S.sel, w);
    save('workouts/' + S.sel, w, opts.debounce ? 700 : 0);
    renderWeek(); renderSummary(); renderProgress();
  }

  // Detail events (delegated)
  const det = $('wk-detail');
  det.addEventListener('focusout', () => setTimeout(() => { if (S.detailDirty && !det.contains(document.activeElement)) renderDetail(); }, 0));
  det.addEventListener('change', (ev) => {
    const t = ev.target;
    if (!S.editing && t.dataset.set) {
      const [i, j] = t.dataset.set.split('-').map(Number); const f = t.dataset.f;
      mutateSel(w => {
        const s = w.exercises[i].sets[j];
        if (f === 'done') { s.done = t.checked; if (t.checked) { if (s.aReps == null || s.aReps === '') s.aReps = s.reps; if (s.aKg == null || s.aKg === '') s.aKg = s.kg; } }
        else s[f] = t.value === '' ? null : Number(t.value);
      });
      if (f === 'done') { S.forceDetail = true; renderDetail(); }
    } else if (!S.editing && t.dataset.fb === 'rpe') {
      mutateSel(w => { w.rpe = t.value ? Number(t.value) : null; });
    } else if (S.editing && (t.dataset.ed === 'date' || t.dataset.ed === 'type')) {
      S.draft[t.dataset.ed] = t.value;
    }
  });
  det.addEventListener('input', (ev) => {
    const t = ev.target;
    if (!S.editing && t.dataset.fb === 'result') { const v = t.value; mutateSel(w => { w.result = v; }, { debounce: true }); return; }
    if (!S.editing) return;
    if (t.dataset.ed) S.draft[t.dataset.ed] = t.value;
    else if (t.dataset.ex) S.draft.exercises[+t.dataset.ex][t.dataset.f] = t.value;
    else if (t.dataset.es) { const [i, j] = t.dataset.es.split('-').map(Number); S.draft.exercises[i].sets[j][t.dataset.f] = t.value === '' ? null : Number(t.value); }
  });
  det.addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    const act = b.dataset.act; const D = S.draft;
    const rerender = () => { S.forceDetail = true; renderDetail(); };
    if (act === 'edit') { S.editing = true; S.confirmDel = false; S.draft = clone(S.workouts.get(S.sel)); S.draft.exercises = S.draft.exercises || []; rerender(); }
    else if (act === 'cancel') { S.editing = false; S.draft = null; S.confirmDel = false; rerender(); }
    else if (act === 'save') {
      const w = clone(D); w.title = (w.title || '').trim() || 'Trening';
      w.exercises = (w.exercises || []).filter(e => (e.name || '').trim()).map(e => ({ ...e, name: e.name.trim() }));
      w.updatedAt = new Date().toISOString();
      S.workouts.set(S.sel, w); save('workouts/' + S.sel, w);
      S.editing = false; S.draft = null; S.weekStart = mondayOf(w.date); renderPlanAll(); toast('Plan zapisany.');
    }
    else if (act === 'delete') {
      if (!S.confirmDel) { S.confirmDel = true; rerender(); return; }
      const id = S.sel; S.workouts.delete(id); remove('workouts/' + id);
      S.sel = null; S.editing = false; S.draft = null; S.confirmDel = false; renderPlanAll(); toast('Trening usunięty.');
    }
    else if (act === 'addex') {
      const name = $('nx-name').value.trim(); if (!name) { $('nx-name').focus(); return; }
      const n = Math.max(1, Math.min(20, Number($('nx-sets').value) || 3)); const reps = $('nx-reps').value === '' ? null : Number($('nx-reps').value); const kg = $('nx-kg').value === '' ? 0 : Number($('nx-kg').value);
      D.exercises.push({ name, note: '', sets: Array.from({ length: n }, () => ({ reps, kg, aReps: null, aKg: null, done: false })) });
      rerender(); $('nx-name').focus();
    }
    else if (act === 'done') { mutateSel(w => { w.done = !w.done; }); rerender(); }
    else if (b.dataset.setadd != null) { const e = D.exercises[+b.dataset.setadd]; const last = e.sets[e.sets.length - 1] || { reps: 10, kg: 0 }; e.sets.push({ reps: last.reps, kg: last.kg, aReps: null, aKg: null, done: false }); rerender(); }
    else if (b.dataset.setdel) { const [i, j] = b.dataset.setdel.split('-').map(Number); D.exercises[i].sets.splice(j, 1); rerender(); }
    else if (b.dataset.exdel != null) { D.exercises.splice(+b.dataset.exdel, 1); rerender(); }
    else if (b.dataset.exmove != null) { const i = +b.dataset.exmove, j = i + Number(b.dataset.dir); const [x] = D.exercises.splice(i, 1); D.exercises.splice(j, 0, x); rerender(); }
  });

  $('week').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.wid) {
      if (S.editing && S.sel !== b.dataset.wid) { S.editing = false; S.draft = null; }
      S.sel = b.dataset.wid; S.confirmDel = false; renderWeek(); S.forceDetail = true; renderDetail();
      $('wk-detail').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
    } else if (b.dataset.add) {
      const id = 'w-' + b.dataset.add + '-' + Math.random().toString(36).slice(2, 7);
      const w = { date: b.dataset.add, type: 'gym', title: 'Nowy trening', target: '', notes: '', exercises: [], done: false, result: '', rpe: null, createdAt: new Date().toISOString() };
      S.workouts.set(id, w); save('workouts/' + id, w);
      S.sel = id; S.editing = true; S.draft = clone(w); renderWeek(); S.forceDetail = true; renderDetail(); $('ed-title').focus(); $('ed-title').select();
    }
  });
  $('wk-prev').onclick = () => { S.weekStart = addDays(S.weekStart, -7); renderWeek(); };
  $('wk-next').onclick = () => { S.weekStart = addDays(S.weekStart, 7); renderWeek(); };
  $('wk-today').onclick = () => { S.weekStart = mondayOf(TODAY); renderWeek(); };

  // Exercise progress
  function progressData(name) {
    return [...S.workouts.values()].filter(w => w.date <= TODAY).flatMap(w => (w.exercises || []).filter(e => e.name === name).map(e => ({ w, e })))
      .map(({ w, e }) => {
        const done = (e.sets || []).filter(s => s.done && s.aKg != null);
        if (!done.length) return null;
        const best = done.reduce((b, s) => (Number(s.aKg) > Number(b.aKg) || (Number(s.aKg) === Number(b.aKg) && Number(s.aReps) > Number(b.aReps))) ? s : b);
        return { date: w.date, best, n: done.length, total: (e.sets || []).length, vol: exVolume(e) };
      }).filter(Boolean).sort((a, b) => a.date < b.date ? -1 : 1);
  }
  function renderProgress() {
    const names = [...new Set([...S.workouts.values()].flatMap(w => (w.exercises || []).filter(e => (e.sets || []).some(s => s.done && Number(s.aKg) > 0)).map(e => e.name)))].sort();
    const sel = $('ex-select');
    if (!names.includes(S.exSel)) S.exSel = names[0] || null;
    sel.innerHTML = names.length ? names.map(n => `<option ${n === S.exSel ? 'selected' : ''}>${esc(n)}</option>`).join('') : '<option>Brak danych</option>';
    sel.disabled = !names.length;
    const pd = S.exSel ? progressData(S.exSel) : [];
    lineChart($('chart-ex'), { data: pd.map(p => ({ d: p.date, v: Number(p.best.aKg), extra: `${p.best.aReps} powt. · ${p.n}/${p.total} serii` })), color: 'var(--s-gym)', name: 'Najcięższa seria', unit: 'kg', h: 190, markers: true, label: 'Postęp w ćwiczeniu', empty: 'Postęp pojawi się po dwóch treningach z wpisanym ciężarem.' });
    $('ex-table').innerHTML = pd.length ? pd.slice(-6).reverse().map(p => `<tr><td class="nowrap">${esc(fmtDW(p.date))}</td><td>${p.best.aReps} × ${fmtN(p.best.aKg)} kg</td><td class="r">${p.n}/${p.total}</td><td class="r">${fmtN(p.vol, 0)} kg</td></tr>`).join('')
      : `<tr><td colspan="4" class="muted">Brak wykonanych serii z ciężarem.</td></tr>`;
  }
  $('ex-select').onchange = (e) => { S.exSel = e.target.value; renderProgress(); };
  function renderPlanAll() { renderWeek(); S.forceDetail = true; renderDetail(); renderProgress(); renderSummary(); }

  // ---------- Food ----------
  function products() {
    const p = { ...BASE_PRODUCTS };
    S.food.forEach(d => (d.meals || []).forEach(m => (m.items || []).forEach(it => { if (!p[it.name] && it.g > 0) p[it.name] = [it.kcal / it.g * 100, it.p / it.g * 100, it.f / it.g * 100, it.c / it.g * 100]; })));
    return p;
  }
  const dayTotals = (doc) => (doc?.meals || []).flatMap(m => m.items || []).reduce((t, it) => ({ kcal: t.kcal + (it.kcal || 0), p: t.p + (it.p || 0), f: t.f + (it.f || 0), c: t.c + (it.c || 0), n: t.n + 1 }), { kcal: 0, p: 0, f: 0, c: 0, n: 0 });
  const foodDoc = () => S.food.get(S.foodDate) || { date: S.foodDate, meals: [], water: null, note: '', coachNote: '' };
  function saveFood(doc) { doc.updatedAt = new Date().toISOString(); S.food.set(doc.date, doc); save('food/' + doc.date, doc); }

  function renderFood() {
    const doc = foodDoc(); const tt = dayTotals(doc); const t = T();
    $('fd-label').textContent = S.foodDate === TODAY ? 'Dziś, ' + fmtD(S.foodDate) : fmtDW(S.foodDate);
    $('fd-total').textContent = tt.n ? `${fmtN(tt.kcal, 0)} kcal · B ${fmtN(tt.p, 0)} g · T ${fmtN(tt.f, 0)} g · W ${fmtN(tt.c, 0)} g` : '';
    const meals = (doc.meals || []).slice().sort((a, b) => (a.time || '99') < (b.time || '99') ? -1 : 1);
    $('meals').innerHTML = meals.length ? meals.map(m => {
      const mi = doc.meals.indexOf(m); const st = dayTotals({ meals: [m] });
      return `<div class="meal"><div class="meal-head"><b>${esc(m.meal)}${m.time ? ` <span class="muted" style="font-weight:500">· ${esc(m.time)}</span>` : ''}</b><span>${fmtN(st.kcal, 0)} kcal</span></div>
        <div class="table-wrap"><table class="food"><thead><tr><th>Produkt</th><th class="r">Ilość</th><th class="r">kcal</th><th class="r">B</th><th class="r">T</th><th class="r">W</th><th></th></tr></thead><tbody>
        ${(m.items || []).map((it, ii) => `<tr><td>${esc(it.name)}</td><td class="r nowrap">${fmtN(it.g, 0)} g</td><td class="r">${fmtN(it.kcal, 0)}</td><td class="r">${fmtN(it.p)}</td><td class="r">${fmtN(it.f)}</td><td class="r">${fmtN(it.c)}</td>
          <td class="r">${S.canWrite ? `<button class="iconbtn" type="button" data-del="${mi}-${ii}" aria-label="Usuń ${esc(it.name)}">×</button>` : ''}</td></tr>`).join('')}
        </tbody></table></div></div>`;
    }).join('') : `<div class="empty">Brak wpisów na ten dzień.${S.canWrite ? ' Dodaj pierwszy produkt w formularzu poniżej.' : ''}</div>`;
    $('add-food').hidden = !S.canWrite || !S.connected;
    const rows = [['Kalorie', tt.kcal, t.kcal, 'kcal'], ['Białko', tt.p, t.protein, 'g'], ['Tłuszcz', tt.f, t.fat, 'g'], ['Węglowodany', tt.c, t.carbs, 'g'], ['Woda', doc.water || 0, t.water, 'l']];
    $('day-goals').innerHTML = rows.map(r => { const pct = r[2] ? r[1] / r[2] * 100 : 0; return `<div class="goal"><div class="gh"><span>${r[0]}</span><span>${fmtN(r[1], r[3] === 'l' ? 1 : 0)} / ${fmtN(r[2], 1)} ${r[3]}</span></div><div class="bar ${pct > 110 ? 'over' : ''}" role="img" aria-label="${r[0]}: ${Math.round(pct)}% celu"><div style="width:${Math.min(100, pct)}%"></div></div></div>`; }).join('');
    const setVal = (id, v) => { const e = $(id); if (document.activeElement !== e) e.value = v ?? ''; e.disabled = !S.canWrite || !S.connected; };
    setVal('fd-water', doc.water); setVal('fd-note', doc.note); setVal('fd-coach', doc.coachNote);
    $('tg-edit').hidden = !S.canWrite || !S.connected;
    const prods = products();
    $('products').innerHTML = Object.keys(prods).sort((a, b) => a.localeCompare(b, 'pl')).map(n => `<option value="${esc(n)}">`).join('');
    renderBalance();
  }
  function renderBalance() {
    const gd = new Map(days().map(d => [d.date, d]));
    const data = [];
    for (let i = 13; i >= 0; i--) {
      const d = addDays(TODAY, -i); const f = S.food.get(d); const g = gd.get(d);
      if (!f || !g || !g.kcalOut || d === TODAY) continue;
      const eaten = dayTotals(f).kcal; if (!eaten) continue;
      data.push({ date: d, eaten, burned: g.kcalOut, v: Math.round(eaten - g.kcalOut) });
    }
    divergingBars($('chart-balance'), { data, label: 'Bilans kalorii', empty: 'Bilans pojawi się, gdy będą wpisy jedzenia i dane z Garmin dla tych samych dni.' });
  }
  $('meals').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-del]'); if (!b) return;
    const [mi, ii] = b.dataset.del.split('-').map(Number); const doc = clone(foodDoc());
    doc.meals[mi].items.splice(ii, 1); if (!doc.meals[mi].items.length) doc.meals.splice(mi, 1);
    saveFood(doc); renderFood();
  });
  // Add-product form
  $('af-meal').innerHTML = MEALS.map(m => `<option>${m}</option>`).join('');
  function defaultMeal() { const h = new Date().getHours(); return h < 10 ? 'Śniadanie' : h < 12 ? 'II śniadanie' : h < 16 ? 'Obiad' : h < 18 ? 'Podwieczorek' : 'Kolacja'; }
  $('af-meal').value = defaultMeal();
  function recalc() {
    const p = products()[$('af-name').value.trim()]; const g = Number($('af-g').value);
    if (p && g > 0) { $('af-kcal').value = Math.round(p[0] * g / 100); $('af-p').value = Math.round(p[1] * g) / 100; $('af-f').value = Math.round(p[2] * g) / 100; $('af-c').value = Math.round(p[3] * g) / 100; $('af-hint').textContent = `Wartości z bazy: ${Math.round(p[0])} kcal na 100 g.`; }
    else if (!p) $('af-hint').textContent = 'Nowy produkt: wpisz kalorie i makro dla podanej ilości. Strona go zapamięta.';
  }
  $('af-name').addEventListener('input', recalc); $('af-g').addEventListener('input', recalc);
  $('add-food').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const name = $('af-name').value.trim(); const g = Number($('af-g').value);
    if (!name || !(g > 0)) return;
    const num = (id) => Math.round((Number($(id).value) || 0) * 10) / 10;
    const item = { name, g, kcal: Math.round(Number($('af-kcal').value) || 0), p: num('af-p'), f: num('af-f'), c: num('af-c') };
    const doc = clone(foodDoc()); doc.meals = doc.meals || [];
    const mealName = $('af-meal').value; let meal = doc.meals.find(m => m.meal === mealName);
    if (!meal) { meal = { meal: mealName, time: $('af-time').value || '', items: [] }; doc.meals.push(meal); } else if ($('af-time').value && !meal.time) meal.time = $('af-time').value;
    meal.items.push(item); saveFood(doc);
    ['af-name', 'af-g', 'af-kcal', 'af-p', 'af-f', 'af-c'].forEach(id => $(id).value = '');
    $('af-name').focus(); renderFood();
  });
  const fieldSaver = (id, key, parseFn) => $(id).addEventListener('input', () => {
    const date = S.foodDate; const v = parseFn ? parseFn($(id).value) : $(id).value;
    const doc = clone(S.food.get(date) || { date, meals: [], water: null, note: '', coachNote: '' }); doc[key] = v;
    doc.updatedAt = new Date().toISOString(); S.food.set(date, doc);
    save('food/' + date, doc, 800);
    if (key === 'water') { const keep = document.activeElement; renderFood(); keep && keep.focus(); }
  });
  fieldSaver('fd-water', 'water', v => v === '' ? null : Number(v)); fieldSaver('fd-note', 'note'); fieldSaver('fd-coach', 'coachNote');
  $('fd-prev').onclick = () => { S.foodDate = addDays(S.foodDate, -1); renderFood(); };
  $('fd-next').onclick = () => { S.foodDate = addDays(S.foodDate, 1); renderFood(); };
  $('fd-today').onclick = () => { S.foodDate = TODAY; renderFood(); };
  // Targets
  $('tg-edit').onclick = () => {
    const t = T(); $('tg-form').hidden = false; $('day-goals').hidden = true; $('tg-edit').hidden = true;
    $('tg-kcal').value = t.kcal; $('tg-p').value = t.protein; $('tg-f').value = t.fat; $('tg-c').value = t.carbs; $('tg-w').value = t.water;
    $('tg-wg').value = t.weightGoal ?? ''; $('tg-fg').value = t.fatGoal ?? ''; $('tg-date').value = t.goalDate || '';
  };
  const closeTargets = () => { $('tg-form').hidden = true; $('day-goals').hidden = false; $('tg-edit').hidden = !S.canWrite; };
  $('tg-cancel').onclick = closeTargets;
  $('tg-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const n = (id) => $(id).value === '' ? null : Number($(id).value);
    S.targets = { kcal: n('tg-kcal'), protein: n('tg-p'), fat: n('tg-f'), carbs: n('tg-c'), water: n('tg-w'), weightGoal: n('tg-wg'), fatGoal: n('tg-fg'), goalDate: $('tg-date').value || null, updatedAt: new Date().toISOString() };
    save('settings/targets', S.targets); closeTargets(); renderFood(); renderSummary(); toast('Cele zapisane.');
  });

  // ---------- Comments ----------
  const roleName = (r) => r === 'coach' ? 'Trener' : 'Zawodnik';
  function renderComments() {
    const host = $('notes'); const list = S.comments;
    if (!list.length) host.innerHTML = `<div class="empty">Brak komentarzy. Napisz pierwszy, np. pytanie do trenera albo uwagę do planu.</div>`;
    else {
      host.innerHTML = '';
      list.forEach(c => {
        const row = document.createElement('div'); row.className = 'note';
        const av = document.createElement('div'); av.className = 'who'; av.textContent = initials(c.authorName || roleName(c.role));
        const nb = document.createElement('div'); nb.className = 'nb';
        const meta = document.createElement('div'); meta.className = 'nm';
        const b = document.createElement('b'); b.textContent = c.authorName || roleName(c.role); meta.appendChild(b);
        const r = document.createElement('span'); r.className = 'pill role'; r.textContent = roleName(c.role); meta.appendChild(r);
        const tm = document.createElement('span'); const d = new Date(c.at); tm.textContent = isNaN(d) ? '' : d.toLocaleString('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); meta.appendChild(tm);
        const tx = document.createElement('p'); tx.textContent = c.text;
        nb.append(meta, tx); row.append(av, nb); host.appendChild(row);
      });
      const last = host.lastElementChild; if (last && S.scrollComments) { S.scrollComments = false; last.scrollIntoView({ block: 'nearest' }); }
    }
    $('compose').hidden = !S.canWrite || !S.connected;
  }
  $('compose').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const inp = $('compose-input'); const text = inp.value.trim(); if (!text || !S.db) return;
    inp.value = ''; S.scrollComments = true;
    try { await S.db.collection('comments').add({ text: text.slice(0, 4000), authorUid: S.me.uid, authorName: S.me.displayName || S.me.email, role: S.role, at: new Date().toISOString() }); }
    catch (e) { inp.value = text; handleWriteError(e); }
  });

  // ---------- Render all ----------
  function renderAll() {
    renderHeader(); renderBanners(); renderSummary(); renderGarmin(); renderWeek(); S.forceDetail = true; renderDetail(); renderProgress(); renderFood(); renderComments();
  }
  document.querySelectorAll('[data-range]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('[data-range]').forEach(x => x.setAttribute('aria-pressed', x === b));
    S.range = +b.dataset.range; renderSummary(); renderGarmin();
  }));
  let rt; let lastW = window.innerWidth;
  window.addEventListener('resize', () => { if (window.innerWidth === lastW) return; lastW = window.innerWidth; clearTimeout(rt); rt = setTimeout(() => { renderSummary(); renderGarmin(); renderProgress(); renderBalance(); }, 150); });
  if (document.fonts) document.fonts.ready.then(() => { if (S.connected) { renderSummary(); renderGarmin(); renderProgress(); renderBalance(); } });

  // ---------- Sign-in and data subscriptions ----------
  function gate(msg, { signin = false, signout = false } = {}) {
    $('app').hidden = true; $('gate').hidden = false;
    $('gate-msg').textContent = msg; $('signin').hidden = !signin; $('gate-signout').hidden = !signout;
  }
  if (firebaseConfig.apiKey === 'REPLACE_ME') { gate('Brak konfiguracji Firebase.\nUzupełnij plik js/config.js (instrukcja w README).'); return; }
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  let fs;
  try { fs = initializeFirestore(app, { ignoreUndefinedProperties: true, localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
  catch (e) { fs = initializeFirestore(app, { ignoreUndefinedProperties: true }); }
  const store = makeStore(fs);
  const provider = new GoogleAuthProvider(); provider.setCustomParameters({ prompt: 'select_account' });
  $('signin').onclick = async () => {
    try { await signInWithPopup(auth, provider); }
    catch (e) { if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') gate(`Nie udało się zalogować (${e.code || 'błąd'}). Spróbuj ponownie.`, { signin: true }); }
  };
  const doSignOut = () => signOut(auth);
  $('signout').onclick = doSignOut; $('gate-signout').onclick = doSignOut;

  function stop() { S.unsubs.forEach(u => u()); S.unsubs = []; }
  onAuthStateChanged(auth, async (user) => {
    stop(); S.connected = false; S.db = null; S.me = user;
    if (!user) { gate('Zaloguj się kontem Google, któremu właściciel dał dostęp.', { signin: true }); return; }
    gate('Sprawdzanie dostępu…');
    let access;
    try { const snap = await store.doc('config/access').get(); access = snap.exists ? snap.data() : null; }
    catch (e) { access = null; }
    const email = (user.email || '').toLowerCase();
    const role = access && email === String(access.athlete || '').toLowerCase() ? 'athlete'
      : access && (access.coaches || []).map(x => String(x).toLowerCase()).includes(email) ? 'coach' : null;
    if (!role) { gate(`Konto ${user.email} nie ma dostępu.\nPoproś właściciela o dodanie tego adresu.`, { signout: true }); return; }
    S.access = access; S.role = role; S.db = store; S.connected = true; S.canWrite = true;
    $('gate').hidden = true; $('app').hidden = false;
    renderAll();
    const onErr = (e) => { if (e && e.code === 'permission-denied') { S.canWrite = false; renderAll(); } };
    const db = store, U = S.unsubs;
    U.push(db.doc('config/access').onSnapshot(s => { if (s.exists) { S.access = s.data(); renderHeader(); } }, onErr));
    U.push(db.doc('garmin/daily').onSnapshot(s => { S.garmin = s.exists ? s.data() : null; renderHeader(); renderBanners(); renderSummary(); renderGarmin(); renderBalance(); }, onErr));
    U.push(db.doc('garmin/activities').onSnapshot(s => { S.acts = s.exists ? s.data() : null; renderGarmin(); }, onErr));
    U.push(db.doc('settings/targets').onSnapshot(s => { S.targets = s.exists ? s.data() : null; renderSummary(); renderFood(); }, onErr));
    U.push(db.collection('workouts').onSnapshot(q => {
      const m = new Map(); q.docs.forEach(d => m.set(d.id, d.data()));
      // keep optimistic local copies for documents with a write still pending
      S.workouts.forEach((w, id) => { if (pendingWrite('workouts/' + id)) m.set(id, w); });
      S.workouts = m;
      if (S.sel && !m.has(S.sel) && !S.editing) S.sel = null;
      renderWeek(); renderDetail(); renderProgress(); renderSummary();
    }, onErr));
    U.push(db.collection('food').orderBy('date', 'desc').limit(180).onSnapshot(q => {
      const m = new Map(); q.docs.forEach(d => m.set(d.id, d.data()));
      S.food.forEach((f, id) => { if (pendingWrite('food/' + id)) m.set(id, f); });
      S.food = m; renderFood();
    }, onErr));
    U.push(db.collection('comments').orderBy('at', 'desc').limit(100).onSnapshot(q => { S.comments = q.docs.map(d => d.data()).reverse(); renderComments(); }, onErr));
  });
})();

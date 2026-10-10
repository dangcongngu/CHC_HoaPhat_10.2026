/* Lượm Lúa - Nộp hồ sơ (check-out) cho điện thoại.
 * Dùng chung database Supabase với app máy tính: gọi các hàm RPC (mark_submitted, list_patients, get_changes...).
 * Không có máy chủ riêng; mã truy cập do nhân viên nhập và chỉ lưu trong trình duyệt của điện thoại. */
(() => {
  'use strict';
  const APP_VERSION = '1.0.1';
  const CFG = window.APP_CONFIG || {};
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------ lưu cấu hình trong máy
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem('ll.' + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem('ll.' + key, JSON.stringify(value)); } catch { /* bỏ qua */ } },
    del(key) { try { localStorage.removeItem('ll.' + key); } catch { /* bỏ qua */ } }
  };

  const state = {
    // URL và khóa publishable lấy từ config.js; chỉ dùng giá trị khác nếu quản trị viên chủ động đổi trong mục "Nâng cao".
    url: store.get('override', null)?.url || CFG.supabaseUrl || '',
    key: store.get('override', null)?.key || CFG.supabasePublishableKey || '',
    access: store.get('access', ''),
    device: store.get('device', 'Điện thoại ' + Math.floor(100 + Math.random() * 900)),
    patients: [],
    byCode: new Map(),
    cursor: null,
    queue: store.get('queue', []),
    history: [],
    view: 'scan',
    shown: CFG.pageSize || 60,
    loaded: false,
    online: false
  };
  store.set('device', state.device);
  store.del('url'); store.del('key');                            // bỏ các giá trị cũ đã lưu ở phiên bản trước

  class NetError extends Error {}
  class ApiError extends Error {}

  // ------------------------------------------------------------ tiện ích
  const pad = (n) => String(n).padStart(2, '0');
  const fmtTime = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const fmtHour = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
  const CODE_RE = /\b[A-Z]{2,10}\d{3,12}\b/i;

  function formatBirth(rec) {
    if (rec.dob && /^\d{4}-\d{2}-\d{2}/.test(rec.dob)) { const [y, m, d] = rec.dob.slice(0, 10).split('-'); return `${d}/${m}/${y}`; }
    return rec.extra?.nam_sinh || rec.extra?.['Năm sinh'] || '';
  }
  const maskCccd = (c) => (c && c.length > 4 ? '•'.repeat(c.length - 4) + c.slice(-4) : c || '');

  // ------------------------------------------------------------ âm thanh / rung
  let audioCtx;
  function tone(freq, start, dur, type = 'sine') {
    try {
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
      o.type = type; o.frequency.value = freq; g.gain.value = 0.18;
      o.connect(g); g.connect(audioCtx.destination);
      const t = audioCtx.currentTime + start; o.start(t); o.stop(t + dur);
    } catch { /* thiết bị không hỗ trợ */ }
  }
  function feedback(kind) {
    if (kind === 'success') { tone(880, 0, 0.12); tone(1320, 0.13, 0.16); navigator.vibrate?.(80); }
    else if (kind === 'warning') { tone(620, 0, 0.14); tone(620, 0.2, 0.14); navigator.vibrate?.([90, 60, 90]); }
    else if (kind === 'error') { tone(220, 0, 0.35, 'square'); navigator.vibrate?.([200, 80, 200]); }
    const box = $('scanbox');
    box.classList.remove('flash-ok', 'flash-warn', 'flash-err');
    box.classList.add(kind === 'success' ? 'flash-ok' : kind === 'warning' ? 'flash-warn' : 'flash-err');
    setTimeout(() => box.classList.remove('flash-ok', 'flash-warn', 'flash-err'), 700);
  }

  // ------------------------------------------------------------ gọi Supabase
  async function rpc(fn, args) {
    if (!state.url || !state.key || !state.access) throw new ApiError('Chưa cấu hình. Vào “Cài đặt” để nhập mã truy cập.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let res;
    try {
      res = await fetch(`${state.url.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
        method: 'POST', headers: { apikey: state.key, 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal: controller.signal
      });
    } catch (e) {
      throw new NetError(e.name === 'AbortError' ? 'Máy chủ không phản hồi (hết thời gian chờ).' : 'Không kết nối được tới máy chủ. Kiểm tra mạng.');
    } finally { clearTimeout(timer); }
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch { /* không phải JSON */ }
    if (!res.ok) {
      if (data?.code === 'PGRST202') throw new ApiError('Database chưa được thiết lập (chưa chạy schema.sql trên Supabase).');
      throw new ApiError(data?.message || `Lỗi máy chủ (HTTP ${res.status}).`);
    }
    return data;
  }
  const withKey = (extra = {}) => ({ p_key: state.access, ...extra });

  function setConn(kind, text) {
    const el = $('conn'); el.className = 'conn ' + kind; $('connText').textContent = text;
  }

  // ------------------------------------------------------------ dữ liệu
  function toRec(d) {
    const rec = {
      code: String(d.ma_nv || '').toUpperCase(), stt: d.stt, name: d.ho_ten || '', gender: d.gioi_tinh, dob: d.ngay_sinh, company: d.cong_ty, cccd: d.cccd,
      extra: d.extra || {}, examinedAt: d.examined_at ? new Date(d.examined_at) : null, submittedAt: d.submitted_at ? new Date(d.submitted_at) : null
    };
    rec.key = fold(`${rec.code}|${rec.name}|${rec.stt ?? ''}`);
    return rec;
  }
  const sttOrder = (a, b) => (a.stt ?? Infinity) - (b.stt ?? Infinity) || a.code.localeCompare(b.code);

  function applyRows(rows) {
    let added = false, changed = false;
    for (const d of rows) {
      const next = toRec(d);
      const cur = state.byCode.get(next.code);
      if (!cur) { state.patients.push(next); state.byCode.set(next.code, next); added = true; continue; }
      const same = cur.name === next.name && cur.stt === next.stt && +cur.examinedAt === +next.examinedAt && +cur.submittedAt === +next.submittedAt;
      if (same) continue;
      Object.assign(cur, next); changed = true;
    }
    if (added) state.patients.sort(sttOrder);
    if (added || changed) { renderCards(); if (state.view === 'list') renderList(); }
  }

  async function loadAll() {
    setConn('wait', 'Đang tải...');
    try {
      const snap = await rpc('list_patients', withKey());
      state.patients = (snap.rows || []).map(toRec);
      state.byCode = new Map(state.patients.map((r) => [r.code, r]));
      state.cursor = snap.server_time;
      state.loaded = true; state.online = true;
      setConn('ok', `${state.patients.length.toLocaleString('vi-VN')} người`);
      $('subtitle').textContent = 'Quét QR khi bệnh nhân ra cổng';
      renderCards(); renderList();
      return true;
    } catch (e) {
      state.online = false;
      setConn('bad', e instanceof NetError ? 'Mất kết nối' : 'Lỗi');
      showSettingsMsg(e.message, true);
      throw e;
    }
  }

  let polling = false;
  async function pollOnce() {
    if (polling || !state.loaded || document.hidden) return;
    polling = true;
    try {
      await flushQueue();
      const since = new Date(new Date(state.cursor).getTime() - 10000).toISOString();   // lùi 10 giây để không sót thay đổi commit muộn
      const snap = await rpc('get_changes', withKey({ p_since: since }));
      state.cursor = snap.server_time;
      if (!state.online) { state.online = true; }
      setConn('ok', `${state.patients.length.toLocaleString('vi-VN')} người`);
      if (snap.rows?.length) applyRows(snap.rows);
    } catch (e) {
      if (e instanceof NetError) { state.online = false; setConn('bad', 'Mất kết nối'); }
      else setConn('bad', 'Lỗi');
    } finally { polling = false; renderQueue(); }
  }

  // ------------------------------------------------------------ hàng đợi khi mất mạng
  function queueAdd(fn, code, at) { state.queue.push({ fn, code, at: at.toISOString() }); store.set('queue', state.queue); renderQueue(); }
  async function flushQueue() {
    while (state.queue.length) {
      const item = state.queue[0];
      try { await rpc(item.fn, withKey({ p_ma_nv: item.code, p_device: state.device, p_at: item.at })); }
      catch (e) { if (e instanceof NetError || e instanceof ApiError) throw e; throw e; }
      state.queue.shift(); store.set('queue', state.queue);
    }
  }
  function renderQueue() {
    const n = state.queue.length;
    $('queueInfo').textContent = n ? `${n} thao tác đang chờ gửi lên máy chủ (sẽ tự gửi khi có mạng).` : 'Không có thao tác nào chờ gửi.';
    $('queueInfo').className = 'msg' + (n ? ' err' : '');
  }

  // ------------------------------------------------------------ nghiệp vụ nộp hồ sơ
  function banner(kind, title, detail) {
    const el = $('banner'); el.className = 'banner ' + kind;
    el.querySelector('.b-title').textContent = title; el.querySelector('.b-detail').textContent = detail || '';
  }
  function logHistory(kind, rec, code, result) {
    state.history.unshift({ time: new Date(), kind, code, name: rec?.name || '', stt: rec?.stt ?? '', result });
    if (state.history.length > 40) state.history.length = 40;
    renderHistory();
  }

  const inflight = new Set();
  async function checkout(code, source) {
    if (inflight.has(code)) return;
    inflight.add(code);
    try {
      const rec = state.byCode.get(code);
      if (rec?.submittedAt) { reportAlready(rec, rec.submittedAt); return; }
      let r;
      try { r = await rpc('mark_submitted', withKey({ p_ma_nv: code, p_device: state.device, p_at: new Date().toISOString() })); }
      catch (e) {
        if (!(e instanceof NetError)) throw e;
        queueAdd('mark_submitted', code, new Date());           // mất mạng: lưu tạm và gửi sau
        if (rec) rec.submittedAt = new Date();
        banner('warning', 'Đã ghi nhận (chờ gửi lên máy chủ)', `${rec?.name || code} (${code})\nMất mạng: đã lưu tạm trên điện thoại, sẽ tự gửi khi có mạng.`);
        logHistory('warning', rec, code, 'Đã nộp (chờ đồng bộ)'); feedback('warning'); renderCards();
        return;
      }
      if (r.status === 'not_found') {
        banner('error', `Không tìm thấy mã ${code}`, 'Mã này không có trong danh sách trên máy chủ.');
        logHistory('error', null, code, 'Không có trong danh sách'); feedback('error'); return;
      }
      const when = r.at ? new Date(r.at) : new Date();
      let local = rec;
      if (!local) { await pollOnce(); local = state.byCode.get(code); }
      if (local) local.submittedAt = when;
      const name = local?.name || r.ho_ten || code;
      if (r.status === 'already') { reportAlready(local || { name, code, stt: '' }, when); return; }
      const examined = local ? !!local.examinedAt : r.examined !== false;
      banner(examined ? 'success' : 'warning', 'Đã ghi nhận nộp hồ sơ',
        `${name} (${code})\nLúc ${fmtTime(when)}${examined ? '' : '\nLưu ý: chưa ghi nhận ĐÃ KHÁM.'}`);
      logHistory(examined ? 'success' : 'warning', local, code, examined ? 'Đã nộp hồ sơ' : 'Đã nộp (chưa ghi nhận khám)');
      feedback(examined ? 'success' : 'warning');
      renderCards(); if (state.view === 'list') renderList();
    } catch (e) {
      banner('error', 'Không ghi nhận được', e.message); logHistory('error', null, code, e.message); feedback('error');
    } finally { inflight.delete(code); }
  }

  function reportAlready(rec, when) {
    const t = fmtTime(when);
    banner('warning', 'Bệnh nhân đã khám xong và nộp hồ sơ', `${rec.name} (${rec.code})\nĐã nộp hồ sơ vào lúc ${t}`);
    logHistory('warning', rec, rec.code, `Đã nộp lúc ${t}`); feedback('warning');
  }

  async function extractCode(text) {
    const direct = text.match(CODE_RE);
    if (direct) return direct[0].toUpperCase();
    if (state.byCode.has(text.toUpperCase())) return text.toUpperCase();
    if (/^https?:\/\//i.test(text)) {                              // QR là link: thử mở để lấy Mã NV (có thể bị chặn bởi trình duyệt)
      try {
        const c = new AbortController(); const timer = setTimeout(() => c.abort(), 6000);
        const res = await fetch(text, { signal: c.signal }); clearTimeout(timer);
        const m = (res.url || '').match(CODE_RE) || (await res.text()).match(CODE_RE);
        if (m) return m[0].toUpperCase();
      } catch { /* bỏ qua */ }
    }
    return null;
  }

  async function handleScanned(raw) {
    const text = String(raw || '').trim();
    if (!text) return;
    if (!state.loaded) { banner('warning', 'Chưa có danh sách', 'Vào “Cài đặt”, nhập mã truy cập và bấm “Lưu và tải danh sách”.'); feedback('warning'); return; }
    const code = await extractCode(text);
    if (!code) { banner('error', 'Không đọc được Mã NV', `Nội dung: ${text.slice(0, 120)}`); logHistory('error', null, text.slice(0, 20), 'Không đọc được mã'); feedback('error'); return; }
    await checkout(code, 'scan');
  }

  // ------------------------------------------------------------ giao diện
  function stats() {
    const p = state.patients;
    return {
      total: p.length, examined: p.filter((x) => x.examinedAt).length, submitted: p.filter((x) => x.submittedAt).length,
      waiting: p.filter((x) => x.examinedAt && !x.submittedAt).length, check: p.filter((x) => x.submittedAt && !x.examinedAt).length
    };
  }
  function renderCards() {
    const s = stats();
    const pct = (a, b) => (b ? `${(a * 100 / b).toFixed(1).replace(/\.0$/, '')}%` : '');
    const card = (cls, title, val, sub, wide = '') => `<div class="card ${cls} ${wide}"><div class="c-title">${title}</div><div class="c-val">${val.toLocaleString('vi-VN')}</div><div class="c-sub">${sub || '&nbsp;'}</div></div>`;
    $('cards').innerHTML =
      card('', 'Tổng danh sách', s.total, 'bệnh nhân') + card('', 'Đã khám', s.examined, pct(s.examined, s.total) + ' tổng danh sách') +
      card('green', 'Đã nộp hồ sơ', s.submitted, s.examined ? pct(s.submitted, s.examined) + ' số đã khám' : '') + card('amber', 'Đã khám - chờ nộp', s.waiting, s.waiting ? 'cần thu hồ sơ' : 'không còn hồ sơ chờ') +
      card('red', 'Nộp nhưng chưa ghi nhận khám', s.check, s.check ? 'cần kiểm tra lại' : 'không có trường hợp lệch', 'wide');
  }

  function filtered() {
    const kw = fold($('search').value.trim());
    const status = $('statusFilter').value;
    const dateOn = $('dateOn').checked; const day = $('dateValue').value; const basis = $('dateBasis').value;
    return state.patients.filter((r) => {
      if (kw && !r.key.includes(kw)) return false;
      if (status === 'submitted' && !r.submittedAt) return false;
      if (status === 'pending' && r.submittedAt) return false;
      if (status === 'waiting' && !(r.examinedAt && !r.submittedAt)) return false;
      if (status === 'notExamined' && r.examinedAt) return false;
      if (dateOn && day) {
        const when = basis === 'examined' ? r.examinedAt : r.submittedAt;
        if (!when || dayKey(when) !== day) return false;
      }
      return true;
    });
  }

  function renderList() {
    const rows = filtered();
    const shown = rows.slice(0, state.shown);
    $('listInfo').textContent = `Hiển thị ${shown.length.toLocaleString('vi-VN')} / ${rows.length.toLocaleString('vi-VN')} (tổng ${state.patients.length.toLocaleString('vi-VN')})`;
    if ($('dateOn').checked && $('dateValue').value) {
      const day = $('dateValue').value;
      const ex = state.patients.filter((r) => r.examinedAt && dayKey(r.examinedAt) === day).length;
      const sub = state.patients.filter((r) => r.submittedAt && dayKey(r.submittedAt) === day).length;
      const [y, m, d] = day.split('-'); $('dayInfo').textContent = `Ngày ${d}/${m}/${y}: đã khám ${ex.toLocaleString('vi-VN')} • đã nộp hồ sơ ${sub.toLocaleString('vi-VN')}`;
    } else $('dayInfo').textContent = '';
    $('list').innerHTML = shown.map((r) => {
      const cls = r.submittedAt ? 'submitted' : r.examinedAt ? 'waiting' : '';
      const chips = (r.examinedAt ? `<span class="chip ex">✓ Khám ${fmtHour(r.examinedAt)}</span>` : '<span class="chip">Chưa khám</span>') +
        (r.submittedAt ? `<span class="chip sub">✓ Nộp ${fmtTime(r.submittedAt)}</span>` : r.examinedAt ? '<span class="chip wait">Chờ nộp hồ sơ</span>' : '');
      return `<li class="item ${cls}" data-code="${esc(r.code)}"><div class="name">${esc(r.name)}</div><div class="meta">${esc(r.code)} • STT ${esc(r.stt ?? '')}</div><div class="chips">${chips}</div></li>`;
    }).join('');
    $('btnMore').hidden = rows.length <= shown.length;
  }

  function renderHistory() {
    $('history').innerHTML = state.history.map((h) =>
      `<li class="${h.kind}"><div class="h-top"><span>${fmtTime(h.time)}</span><span>${esc(h.code)}${h.stt !== '' ? ' • STT ' + esc(h.stt) : ''}</span></div><div><strong>${esc(h.name)}</strong> ${esc(h.result)}</div></li>`).join('');
  }

  function showView(name) {
    state.view = name;
    for (const v of ['scan', 'list', 'settings']) $('view-' + v).hidden = v !== name;
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    if (name !== 'scan') stopCamera();
    if (name === 'list') { renderCards(); renderList(); }
    if (name === 'settings') { renderQueue(); }
    window.scrollTo(0, 0);
  }

  // ------------------------------------------------------------ chi tiết bệnh nhân
  let detailCode = null;
  function openDetail(code) {
    const r = state.byCode.get(code); if (!r) return;
    detailCode = code;
    $('detailBody').innerHTML = `<h2>${esc(r.name)}</h2><div class="meta">${esc(r.code)} • STT ${esc(r.stt ?? '')}</div>
      <div class="kv"><span>Ngày/năm sinh</span><span>${esc(formatBirth(r))}</span><span>Giới tính</span><span>${esc(r.gender || '')}</span>
      <span>Công ty</span><span>${esc(r.company || '')}</span><span>CCCD</span><span>${esc(maskCccd(r.cccd))}</span>
      <span>Đã khám</span><span>${r.examinedAt ? '✓ ' + fmtTime(r.examinedAt) : 'Chưa'}</span>
      <span>Nộp hồ sơ</span><span>${r.submittedAt ? '✓ ' + fmtTime(r.submittedAt) : 'Chưa'}</span></div>`;
    const btn = $('detailAction');
    btn.textContent = r.submittedAt ? 'Bỏ đánh dấu đã nộp' : 'Đánh dấu đã nộp hồ sơ';
    btn.className = 'btn ' + (r.submittedAt ? 'danger' : 'success');
    $('detail').showModal();
  }
  async function detailAction() {
    const r = state.byCode.get(detailCode); if (!r) return;
    if (!r.submittedAt) { $('detail').close(); await checkout(r.code, 'tay'); showView('list'); return; }
    if (!confirm(`Bệnh nhân đã nộp hồ sơ lúc ${fmtTime(r.submittedAt)}.\n\nBỏ đánh dấu đã nộp cho ${r.name}?`)) return;
    try {
      await rpc('unmark_submitted', withKey({ p_ma_nv: r.code, p_device: state.device }));
      r.submittedAt = null; banner('info', 'Đã bỏ đánh dấu nộp hồ sơ', `${r.name} (${r.code})`); logHistory('', r, r.code, 'Bỏ đánh dấu nộp');
      renderCards(); renderList(); $('detail').close();
    } catch (e) { alert(e.message); }
  }

  // ------------------------------------------------------------ camera quét QR
  let stream = null, scanning = false, detector = null, lastText = '', lastAt = 0, lastTick = 0, decoding = false;
  const video = $('video'); const canvas = $('canvas');

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) { $('scanHint').textContent = 'Trình duyệt không hỗ trợ camera (cần mở bằng HTTPS).'; return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      video.srcObject = stream; await video.play();
      if ('BarcodeDetector' in window) { try { detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch { detector = null; } }
      scanning = true; $('scanbox').classList.remove('idle');
      $('scanHint').textContent = 'Đưa mã QR vào khung'; $('btnCamera').textContent = 'Tắt camera';
      const track = stream.getVideoTracks()[0]; const caps = track.getCapabilities?.() || {};
      $('btnTorch').hidden = !caps.torch;
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();     // mở âm thanh sau thao tác chạm của người dùng
      requestAnimationFrame(loop);
    } catch (e) {
      $('scanHint').textContent = e.name === 'NotAllowedError' ? 'Chưa cho phép dùng camera. Hãy cấp quyền camera cho trang web.' : `Không bật được camera: ${e.message}`;
    }
  }
  function stopCamera() {
    scanning = false;
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    video.srcObject = null; $('scanbox').classList.add('idle'); $('btnTorch').hidden = true;
    $('btnCamera').textContent = 'Bật camera'; $('scanHint').textContent = 'Bấm “Bật camera” để quét mã QR';
  }
  function loop(now) {
    if (!scanning) return;
    if (video.readyState >= 2 && now - lastTick > 140 && !decoding) { lastTick = now; decodeFrame(); }
    requestAnimationFrame(loop);
  }
  async function decodeFrame() {
    decoding = true;
    try {
      let text = null;
      if (detector) { const codes = await detector.detect(video); if (codes.length) text = codes[0].rawValue; }
      else if (typeof jsQR === 'function') {
        const scale = Math.min(1, 640 / (video.videoWidth || 640));
        const w = Math.max(1, Math.round(video.videoWidth * scale)), h = Math.max(1, Math.round(video.videoHeight * scale));
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(video, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h); const code = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
        if (code) text = code.data;
      }
      if (text) {
        const now = Date.now();
        if (text === lastText && now - lastAt < 3000) return;          // bỏ qua mã vừa quét (còn trong khung hình)
        lastText = text; lastAt = now;
        handleScanned(text);
      }
    } catch { /* bỏ qua frame lỗi */ } finally { decoding = false; }
  }
  async function toggleTorch() {
    const track = stream?.getVideoTracks()[0]; if (!track) return;
    const on = !(track.getSettings().torch); try { await track.applyConstraints({ advanced: [{ torch: on }] }); } catch { /* không hỗ trợ */ }
  }

  // ------------------------------------------------------------ cài đặt
  function showSettingsMsg(text, isErr) { const el = $('settingsMsg'); el.textContent = text; el.className = 'msg ' + (isErr ? 'err' : 'ok'); }
  function fillSettings() { $('setUrl').value = state.url; $('setKey').value = state.key; $('setAccess').value = state.access; $('setDevice').value = state.device; }
  async function saveSettings() {
    state.url = $('setUrl').value.trim(); state.key = $('setKey').value.trim(); state.access = $('setAccess').value.trim();
    state.device = $('setDevice').value.trim() || state.device;
    store.set('access', state.access); store.set('device', state.device);
    if (state.url !== CFG.supabaseUrl || state.key !== CFG.supabasePublishableKey) store.set('override', { url: state.url, key: state.key });
    else store.del('override');
    if (!state.url || !state.key || !state.access) { showSettingsMsg('Cần nhập đủ Project URL, Publishable key và Mã truy cập.', true); return; }
    showSettingsMsg('Đang kết nối...', false);
    try { await loadAll(); showSettingsMsg(`Kết nối thành công, đã tải ${state.patients.length.toLocaleString('vi-VN')} bệnh nhân.`, false); showView('scan'); }
    catch { /* thông báo đã hiển thị trong loadAll */ }
  }

  // ------------------------------------------------------------ khởi tạo
  function init() {
    fillSettings(); renderQueue(); renderHistory(); renderCards();
    $('version').textContent = `Phiên bản ${APP_VERSION}`;
    $('dateValue').value = dayKey(new Date());
    document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
    $('btnCamera').addEventListener('click', () => (scanning ? stopCamera() : startCamera()));
    $('btnTorch').addEventListener('click', toggleTorch);
    $('manualForm').addEventListener('submit', async (e) => {
      e.preventDefault(); const v = $('manualInput').value; $('manualInput').value = ''; await handleScanned(v); $('manualInput').focus();
    });
    $('manualInput').addEventListener('input', (e) => {                // máy quét cầm tay Bluetooth: dán nguyên chuỗi dài
      const v = e.target.value.trim(); if (v.length > 30 || /^https?:\/\//i.test(v)) { e.target.value = ''; handleScanned(v); }
    });
    for (const id of ['search', 'statusFilter', 'dateOn', 'dateBasis', 'dateValue']) $(id).addEventListener('input', () => { state.shown = CFG.pageSize || 60; renderList(); });
    $('btnToday').addEventListener('click', () => { $('dateValue').value = dayKey(new Date()); $('dateOn').checked = true; state.shown = CFG.pageSize || 60; renderList(); });
    $('btnMore').addEventListener('click', () => { state.shown += CFG.pageSize || 60; renderList(); });
    $('list').addEventListener('click', (e) => { const li = e.target.closest('.item'); if (li) openDetail(li.dataset.code); });
    $('detailClose').addEventListener('click', () => $('detail').close());
    $('detailAction').addEventListener('click', detailAction);
    $('btnSave').addEventListener('click', saveSettings);
    $('btnLogout').addEventListener('click', () => {
      if (!confirm('Xóa mã truy cập khỏi điện thoại này?')) return;
      state.access = ''; store.del('access'); state.loaded = false; state.patients = []; state.byCode.clear(); fillSettings(); renderCards(); renderList();
      setConn('', 'Chưa kết nối'); showSettingsMsg('Đã xóa mã truy cập.', false);
    });
    $('btnFlush').addEventListener('click', async () => { try { await flushQueue(); showSettingsMsg('Đã gửi xong.', false); } catch (e) { showSettingsMsg(e.message, true); } renderQueue(); });
    $('btnReload').addEventListener('click', async () => { try { await loadAll(); showSettingsMsg('Đã tải lại danh sách.', false); } catch { /* đã báo lỗi */ } });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollOnce(); });
    window.addEventListener('online', () => pollOnce());
    setInterval(pollOnce, (CFG.pollSeconds || 3) * 1000);

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* bỏ qua */ });
    }
    if (state.access) loadAll().catch(() => showView('settings'));
    else showView('settings');
  }
  init();
  window.__app = { state, handleScanned, checkout, loadAll, pollOnce };      // phục vụ kiểm thử
})();

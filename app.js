/* Lượm Lúa - Nộp hồ sơ (check-out) cho điện thoại.
 * Dùng chung database Supabase với app máy tính: gọi các hàm RPC (mark_submitted, list_patients, get_changes...).
 * Không có máy chủ riêng; mã truy cập do nhân viên nhập và chỉ lưu trong trình duyệt của điện thoại. */
(() => {
  'use strict';
  const APP_VERSION = '1.0.21';
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
      if (data?.code === 'PGRST202') throw new ApiError('Dữ liệu Cloud chưa được thiết lập (quản trị viên cần chạy file schema.sql trước).');
      throw new ApiError(data?.message || `Lỗi máy chủ (HTTP ${res.status}).`);
    }
    return data;
  }
  const withKey = (extra = {}) => ({ p_key: state.access, ...extra });

  function setConn(kind, text) {
    const el = $('conn'); el.className = 'conn ' + kind; $('connText').textContent = text;
  }

  // ------------------------------------------------------------ dữ liệu
  const LOAI_NN = 'Khám Nghề Nghiệp'; const LOAI_DK = 'Khám Định Kỳ'; const LOAI_BOTH = LOAI_NN + ' + ' + LOAI_DK; const LOAI_NONE = 'Chưa phân loại';
  function normLoai(v) {
    if (!v || !String(v).trim()) return '';
    const k = fold(v).replace(/\s+/g, '');
    const nn = k.includes('nghenghiep'); const dk = k.includes('dinhky') || k.includes('dinhki');
    return nn && dk ? LOAI_BOTH : nn ? LOAI_NN : dk ? LOAI_DK : String(v).trim();
  }
  const loaiName = (name) => (name === LOAI_NN ? 'Nghề nghiệp' : name === LOAI_DK ? 'Định kỳ' : name === LOAI_BOTH ? '2 loại' : name === LOAI_NONE ? 'Chưa phân loại' : name);
  const loaiChip = (r) => { const t = loaiTag(r.loai); return t ? `<span class="chip loai ${t.cls}">${esc(r.loai === LOAI_BOTH ? '⚠ 2 loại' : loaiName(r.loai))}</span>` : ''; };
  const loaiShort = (r) => (r.loai === LOAI_BOTH ? 'Nghề nghiệp + Định kỳ' : loaiName(r.loai || ''));
  /** Thống kê theo Loại BN: [{ name, total, examined, submitted }] (chỉ khi danh sách có cột Loại BN). */
  function loaiStats(list) {
    if (!list.some((x) => x.loai)) return [];
    const known = [LOAI_NN, LOAI_DK, LOAI_BOTH];
    // Tính THEO LƯỢT: nhân viên khám cả hai loại được tính ở cả nhóm nghề nghiệp lẫn định kỳ (số từng nhóm khớp số dòng import); LOAI_BOTH chỉ là dòng thông tin "trong đó".
    const groups = [[LOAI_NN, (x) => x.loai === LOAI_NN || x.loai === LOAI_BOTH], [LOAI_DK, (x) => x.loai === LOAI_DK || x.loai === LOAI_BOTH], [LOAI_BOTH, (x) => x.loai === LOAI_BOTH], [LOAI_NONE, (x) => !known.includes(x.loai)]];
    return groups.map(([name, test]) => { const g = list.filter(test); return { name, total: g.length, examined: g.filter((x) => x.examinedAt).length, submitted: g.filter((x) => x.submittedAt).length }; }).filter((g) => g.total > 0);
  }
  /** Chú thích dưới ô "Tổng danh sách": số bệnh nhân từng loại (chỉ hiện khi danh sách có cột Loại BN). */
  /** Thẻ nhỏ có màu: "NN 80", "ĐK 40", "2 loại 12" (nhân viên khám 2 loại tính ở cả nhóm NN lẫn ĐK). */
  function loaiPills(group) {
    const all = loaiStats(state.patients); if (!all.length) return '';
    const g = loaiStats(group); const n = (v) => v.toLocaleString('vi-VN');
    const count = (name) => (g.find((y) => y.name === name) || { total: 0 }).total;
    const cls = { [LOAI_NN]: 'nn', [LOAI_DK]: 'dk', [LOAI_BOTH]: 'both', [LOAI_NONE]: 'none' };
    const label = { [LOAI_NN]: 'NN', [LOAI_DK]: 'ĐK', [LOAI_BOTH]: '2 loại', [LOAI_NONE]: 'Chưa PL' };
    const keyOf = { [LOAI_NN]: 'NN', [LOAI_DK]: 'DK', [LOAI_BOTH]: 'BOTH', [LOAI_NONE]: 'NONE' };
    return all.map((x) => ((x.name === LOAI_NONE || x.name === LOAI_BOTH) && !count(x.name) ? '' : `<span class="pill ${cls[x.name]}" data-loai="${keyOf[x.name]}" title="Bấm để lọc danh sách">${label[x.name]} ${n(count(x.name))}</span>`)).join('');
  }
  function totalSub(list) { const p = loaiPills(list); return p ? `bệnh nhân<br>${p}` : 'bệnh nhân'; }

  function toRec(d) {
    const rec = {
      code: String(d.ma_nv || '').toUpperCase(), stt: d.stt, name: d.ho_ten || '', gender: d.gioi_tinh, dob: d.ngay_sinh, company: d.cong_ty, cccd: d.cccd,
      loai: normLoai(d.loai_bn), extra: d.extra || {}, examinedAt: d.examined_at ? new Date(d.examined_at) : null, submittedAt: d.submitted_at ? new Date(d.submitted_at) : null
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
      const same = cur.name === next.name && cur.stt === next.stt && cur.loai === next.loai && +cur.examinedAt === +next.examinedAt && +cur.submittedAt === +next.submittedAt;
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
      renderCards(); renderList(); renderQuick();
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
  /** Thẻ phân loại BN: { text, cls } hoặc null. Màu: nghề nghiệp xanh ngọc, định kỳ xanh chàm, cả hai đỏ tươi. */
  function loaiTag(loai) {
    if (!loai) return null;
    if (loai === LOAI_BOTH) return { text: 'KHÁM 2 LOẠI: NGHỀ NGHIỆP + ĐỊNH KỲ', cls: 'loai-both' };
    return { text: String(loai).toUpperCase(), cls: loai === LOAI_NN ? 'loai-nn' : loai === LOAI_DK ? 'loai-dk' : 'loai-other' };
  }
  /** Loại BN của bệnh nhân ở dòng đầu "Họ tên (MÃ)" của nội dung thông báo. */
  function loaiOfDetail(detail) {
    const m = /\(([A-Za-z0-9]+)\)\s*$/.exec(String(detail || '').split('\n')[0] || '');
    return m ? (state.byCode.get(m[1].toUpperCase())?.loai || '') : '';
  }
  function banner(kind, title, detail, undoCode = null) {
    const el = $('banner'); el.className = 'banner ' + kind;
    const tag = loaiTag(loaiOfDetail(detail));
    el.querySelector('.b-title').textContent = title; el.querySelector('.b-detail').textContent = detail || '';
    const bt = $('bannerTag'); bt.hidden = !tag; if (tag) { bt.textContent = tag.text; bt.className = 'b-tag ' + tag.cls; }
    state.undoCode = undoCode; $('btnUndo').hidden = !undoCode;       // nút "Bỏ tick" chỉ hiện khi bệnh nhân đã nộp hồ sơ
    showPopup(kind, title, detail, undoCode);
  }

  // ------------------------------------------------------------ popup kết quả quét (hiện giữa màn hình)
  let popupTimer = null;
  const POPUP_ICON = { success: '✓', warning: '!', error: '✕', info: 'i' };
  function showPopup(kind, title, detail, undoCode) {
    const card = $('popupCard');
    card.className = 'popup-card ' + (POPUP_ICON[kind] ? kind : 'info');
    $('popupIcon').textContent = POPUP_ICON[kind] || 'i';
    // thành công: mascot "like"; lỗi: mascot "hủy"; loại khác giữ ký hiệu
    const mascot = kind === 'success' ? 'icons/mascot.png' : kind === 'error' ? 'icons/mascot-cancel.png' : '';
    $('popupMascot').hidden = !mascot; $('popupIcon').hidden = !!mascot; if (mascot) $('popupMascot').src = mascot;
    $('popupTitle').textContent = title;
    const lines = String(detail || '').split('\n');
    const hasName = /\([A-Za-z0-9]+\)\s*$/.test(lines[0] || '');                // dòng đầu dạng "Họ tên (MÃ)"
    $('popupName').textContent = hasName ? lines.shift() : '';
    const tag = loaiTag(loaiOfDetail(detail));
    if (tag && tag.cls === 'loai-both') lines.unshift('Kiểm tra đủ 2 bộ hồ sơ giấy: nghề nghiệp + định kỳ.');
    const pt = $('popupTag'); pt.hidden = !tag; if (tag) { pt.textContent = tag.text; pt.className = 'p-tag ' + tag.cls; }
    $('popupDetail').textContent = lines.join('\n');
    $('popupUndo').hidden = !undoCode;
    $('popupOk').textContent = undoCode ? 'Đóng' : 'OK';
    $('popupOk').className = 'btn ' + (undoCode ? '' : 'primary');
    $('popup').hidden = false; state.popupOpen = true;
    clearTimeout(popupTimer);
    // thành công tự đóng nhanh; cần thao tác (đã nộp) thì ở lại cho tới khi người dùng đóng
    let ms = undoCode ? 0 : kind === 'success' || kind === 'info' ? 2500 : kind === 'warning' ? 4500 : 5500;
    if (ms && tag) ms = Math.max(ms, 6000);                      // người phụ trách cần thời gian đối chiếu hồ sơ
    const timer = $('popupTimer'); timer.classList.remove('run');
    if (ms) { timer.style.setProperty('--dur', ms + 'ms'); void timer.offsetWidth; timer.classList.add('run'); popupTimer = setTimeout(closePopup, ms); }
  }
  function closePopup() { clearTimeout(popupTimer); $('popup').hidden = true; state.popupOpen = false; $('popupTimer').classList.remove('run'); lastAt = Date.now(); }   // mã đang trong khung hình không bị đọc lại ngay
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
    banner('warning', 'Bệnh nhân khám xong và đã nộp hồ sơ', `${rec.name} (${rec.code})\nĐã nộp hồ sơ vào lúc ${t}`, rec.code);
    logHistory('warning', rec, rec.code, `Đã nộp lúc ${t}`); feedback('warning');
  }

  // ------------------------------------------------------------ hộp xác nhận có mascot (thay cho confirm() của trình duyệt)
  function askConfirm({ title, name = '', detail = '', okText = 'Xác nhận', cancelText = 'Hủy', kind = 'info', danger = false, mascot = 'ok', altText = '' }) {
    return new Promise((resolve) => {
      const box = $('askBox'); $('askCard').className = 'popup-card ' + kind;
      $('askTitle').textContent = title; $('askName').textContent = name; $('askDetail').textContent = detail;
      $('askOk').textContent = okText; $('askCancel').textContent = cancelText;
      $('askOk').className = 'btn ' + (danger ? 'danger' : 'primary');
      $('askMascot').src = mascot === 'cancel' ? 'icons/mascot-cancel.png' : 'icons/mascot.png';
      $('askAlt').hidden = !altText; $('askAlt').textContent = altText;
      let answer = '';
      const done = (value) => { answer = value; if (box.open) box.close(); };
      const onOk = () => done('ok'), onAlt = () => done('alt'), onCancel = () => done('');
      const onClose = () => { $('askOk').removeEventListener('click', onOk); $('askAlt').removeEventListener('click', onAlt); $('askCancel').removeEventListener('click', onCancel); box.removeEventListener('close', onClose); box.removeEventListener('cancel', onClose); resolve(answer); };
      $('askOk').addEventListener('click', onOk); $('askAlt').addEventListener('click', onAlt); $('askCancel').addEventListener('click', onCancel);
      box.addEventListener('close', onClose); box.addEventListener('cancel', () => { answer = ''; });
      box.addEventListener('click', (e) => { if (e.target === box || e.target.classList.contains('ask-wrap')) done(''); });
      box.showModal(); (danger ? $('askCancel') : $('askOk')).focus();
    });
  }

  // Bỏ đánh dấu đã nộp (đưa về chưa nộp hồ sơ) từ thông báo sau khi quét.
  async function undoSubmitted() {
    const code = state.undoCode; if (!code) return;
    const rec = state.byCode.get(code); const name = rec?.name || code;
    if (!await askConfirm({ title: 'Bỏ đánh dấu nộp hồ sơ', name: `${name} (${code})`, detail: 'Trạng thái sẽ trở về CHƯA NỘP HỒ SƠ.', okText: 'Bỏ đánh dấu', cancelText: 'Giữ nguyên', kind: 'warning', danger: true, mascot: 'cancel' })) return;
    let offline = false;
    try { await rpc('unmark_submitted', withKey({ p_ma_nv: code, p_device: state.device })); }
    catch (e) {
      if (!(e instanceof NetError)) { banner('error', 'Không bỏ được đánh dấu', e.message); feedback('error'); return; }
      queueAdd('unmark_submitted', code, new Date()); offline = true;      // mất mạng: lưu tạm, gửi sau
    }
    if (rec) rec.submittedAt = null;
    banner('info', 'Đã bỏ đánh dấu nộp hồ sơ', `${name} (${code})\nTrạng thái: chưa nộp hồ sơ${offline ? '\n(Mất mạng: sẽ tự gửi khi có mạng.)' : ''}`);
    logHistory('', rec, code, 'Bỏ đánh dấu nộp'); feedback('warning');
    renderCards(); if (state.view === 'list') renderList();
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
  /** Dòng "Nghề nghiệp a • Định kỳ b" của một nhóm (đã khám, đã nộp...) so với toàn danh sách; rỗng nếu không có cột Loại BN. */
  function loaiLine(group) { return loaiPills(group); }
  /** Bộ lọc loại BN (khóa NN / DK / BOTH / NONE): NN và ĐK tính cả người khám 2 loại, giống số liệu trên ô thống kê. */
  function matchLoai(v, key) {
    if (key === 'NN') return v === LOAI_NN || v === LOAI_BOTH;
    if (key === 'DK') return v === LOAI_DK || v === LOAI_BOTH;
    if (key === 'BOTH') return v === LOAI_BOTH;
    if (key === 'NONE') return ![LOAI_NN, LOAI_DK, LOAI_BOTH].includes(v);
    return true;
  }
  function refreshAll() { state.shown = CFG.pageSize || 60; renderList(); renderCards(); renderLoaiBar(); }
  function setBasis(basis) {
    $('dateBasis').value = basis;
    $('basisSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.basis === basis));
  }
  function renderLoaiBar() {
    const bar = $('loaiBar');
    if (!state.loaiFilter) { bar.hidden = true; bar.innerHTML = ''; return; }
    const names = { NN: ['nn', 'NN · Nghề nghiệp'], DK: ['dk', 'ĐK · Định kỳ'], BOTH: ['both', '2 loại'], NONE: ['none', 'Chưa phân loại'] };
    const [cls, text] = names[state.loaiFilter];
    bar.hidden = false;
    bar.innerHTML = `Đang lọc loại: <span class="pill ${cls}">${text}</span><button type="button" id="btnClearLoai">✕ Bỏ lọc</button>`;
    $('btnClearLoai').addEventListener('click', () => { state.loaiFilter = null; refreshAll(); });
  }
  /** Bấm vào ô thống kê: lọc danh sách đúng nhóm mà ô đó đếm; vùng "hôm nay" thì lọc theo ngày; thẻ loại thì lọc thêm theo loại. */
  function applyCardFilter(key, loai, inDay) {
    state.loaiFilter = loai || null;
    $('search').value = '';
    if (inDay && (key === 'examined' || key === 'submitted')) {
      $('statusFilter').value = key;
      setBasis(key);
      $('dateOn').checked = true;
      if (!$('dateValue').value) $('dateValue').value = dayKey(new Date());
    } else {
      $('dateOn').checked = false;
      $('statusFilter').value = { examined: 'examined', submitted: 'submitted', waiting: 'waiting', check: 'check' }[key] || 'all';
    }
    refreshAll();
    $('listInfo').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function renderCards() {
    const s = stats();
    const P = state.patients;
    const pct = (a, b) => (b ? `${(a * 100 / b).toFixed(1).replace(/\.0$/, '')}%` : '');
    const n = (v) => v.toLocaleString('vi-VN');
    // Số liệu theo ngày: ngày đang chọn ở bộ lọc ngày, không lọc thì là hôm nay.
    const filtered = $('dateOn')?.checked && $('dateValue')?.value;
    const day = filtered ? $('dateValue').value : dayKey(new Date());
    const [dy, dm, dd] = day.split('-');
    const label = `${filtered ? 'Ngày' : 'Hôm nay'} ${dd}/${dm}`;
    const received = P.filter((x) => x.examinedAt && dayKey(x.examinedAt) === day);
    const submitted = P.filter((x) => x.submittedAt && dayKey(x.submittedAt) === day);
    const recWaiting = received.filter((x) => !x.submittedAt).length;
    const sameDay = submitted.filter((x) => x.examinedAt && dayKey(x.examinedAt) === day).length;
    const otherDay = submitted.filter((x) => x.examinedAt && dayKey(x.examinedAt) !== day).length;
    const noExam = submitted.filter((x) => !x.examinedAt).length;
    const dayBlock = (value, unit, detail, group) => `<div class="dayzone"><div class="c-day">${label}:<span class="dv">${n(value)} ${unit}</span></div><div class="c-det">${detail}</div><div>${loaiLine(group)}</div></div>`;
    const KEYS = { 'Tổng danh sách': 'total', 'Đã khám': 'examined', 'Đã nộp hồ sơ': 'submitted', 'Chờ nộp hồ sơ': 'waiting', 'Nộp nhưng chưa ghi nhận khám': 'check' };
    const card = (cls, title, val, sub, group, extra = '', wide = '') => `<div class="card ${cls} ${wide}" data-card="${KEYS[title]}"><div class="c-title">${title}</div><div class="c-val">${n(val)}</div><div class="c-sub">${sub || '&nbsp;'}</div><div>${group ? loaiLine(group) : ''}</div>${extra}</div>`;
    const detSubmitted = [`${n(sameDay)} cùng ngày`, otherDay ? `${n(otherDay)} ngày khác` : '', noExam ? `${n(noExam)} chưa tick` : ''].filter(Boolean).join(' + ');
    $('cards').innerHTML =
      card('', 'Tổng danh sách', s.total, 'bệnh nhân', P) +
      card('', 'Đã khám', s.examined, pct(s.examined, s.total) + ' tổng danh sách', P.filter((x) => x.examinedAt), dayBlock(received.length, 'khám', `${n(recWaiting)} chờ nộp + ${n(received.length - recWaiting)} đã nộp`, received)) +
      card('green', 'Đã nộp hồ sơ', s.submitted, s.examined ? pct(s.submitted, s.examined) + ' số đã khám' : '', P.filter((x) => x.submittedAt), dayBlock(submitted.length, 'nộp', detSubmitted, submitted)) +
      card('amber', 'Chờ nộp hồ sơ', s.waiting, s.waiting ? 'đã khám, chưa nộp' : 'không còn hồ sơ chờ', P.filter((x) => x.examinedAt && !x.submittedAt)) +
      card('red', 'Nộp nhưng chưa ghi nhận khám', s.check, s.check ? 'cần kiểm tra lại' : 'không có trường hợp lệch', null, '', 'wide');
  }

  function filtered() {
    const kw = fold($('search').value.trim());
    const status = $('statusFilter').value;
    const dateOn = $('dateOn').checked; const day = $('dateValue').value; const basis = $('dateBasis').value;
    return state.patients.filter((r) => {
      if (kw && !r.key.includes(kw)) return false;
      if (state.loaiFilter && !matchLoai(r.loai, state.loaiFilter)) return false;
      if (status === 'examined' && !r.examinedAt) return false;
      if (status === 'check' && !(r.submittedAt && !r.examinedAt)) return false;
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
      const [y, m, d] = day.split('-'); const byLoai = (field) => { const g = loaiStats(state.patients.filter((r) => r[field] && dayKey(r[field]) === day)); return g.length ? ` (${g.filter((x) => x.name !== LOAI_BOTH).map((x) => `${loaiName(x.name)} ${x.total.toLocaleString('vi-VN')}`).join(' • ')}${(g.find((x) => x.name === LOAI_BOTH) || {}).total ? `, cả hai ${(g.find((x) => x.name === LOAI_BOTH)).total.toLocaleString('vi-VN')}` : ''})` : ''; };
      $('dayInfo').textContent = `Ngày ${d}/${m}/${y}: đã khám ${ex.toLocaleString('vi-VN')}${byLoai('examinedAt')} • đã nộp hồ sơ ${sub.toLocaleString('vi-VN')}${byLoai('submittedAt')}`;
    } else $('dayInfo').textContent = '';
    $('list').innerHTML = shown.map((r) => {
      const cls = r.submittedAt ? 'submitted' : r.examinedAt ? 'waiting' : '';
      const chips = (r.examinedAt ? `<span class="chip ex">✓ Khám ${fmtHour(r.examinedAt)}</span>` : '<span class="chip">Chưa đến khám</span>') +
        (r.submittedAt ? `<span class="chip sub">✓ Nộp ${fmtTime(r.submittedAt)}</span>` + (r.examinedAt ? '' : '<span class="chip wait">Chưa ghi nhận khám</span>') : r.examinedAt ? '<span class="chip wait">Chờ nộp hồ sơ</span>' : '');
      return `<li class="item ${cls}" data-code="${esc(r.code)}"><div class="name">${esc(r.name)}</div><div class="meta">${esc(r.code)} • STT ${esc(r.stt ?? '')}</div><div class="chips">${loaiChip(r)}${chips}</div></li>`;
    }).join('');
    $('btnMore').hidden = rows.length <= shown.length;
  }

  // ------------------------------------------------------------ xuất / chia sẻ danh sách theo bộ lọc hiện tại
  function statusText(r) { return r.submittedAt ? (r.examinedAt ? 'Đã nộp hồ sơ' : 'Nộp nhưng chưa ghi nhận khám') : r.examinedAt ? 'Chờ nộp hồ sơ' : 'Chưa đến khám'; }
  function loadScript(src) {
    return new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = reject; document.head.appendChild(s); });
  }
  function exportName(ext) {
    const d = new Date(); const part = (v) => String(v).padStart(2, '0');
    const label = fold($('statusFilter').selectedOptions[0].textContent.split('(')[0].trim()).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    return `DanhSach_${label}_${d.getFullYear()}${part(d.getMonth() + 1)}${part(d.getDate())}_${part(d.getHours())}${part(d.getMinutes())}.${ext}`;
  }
  async function exportList() {
    let rows = filtered();
    const msg = $('exportMsg');
    // Đang lọc theo ngày: hỏi xuất theo ngày (danh sách đang lọc) hay xuất tất cả
    if ($('dateOn').checked && $('dateValue').value) {
      const [y, m, d] = $('dateValue').value.split('-');
      const choice = await askConfirm({
        title: 'Xuất danh sách', name: `Đang lọc theo ngày ${d}/${m}/${y}`,
        detail: '• Xuất theo ngày: danh sách đang lọc của ngày này.\n• Xuất tất cả: toàn bộ danh sách bệnh nhân.',
        okText: 'Xuất theo ngày', altText: 'Xuất tất cả', cancelText: 'Hủy'
      });
      if (!choice) return;
      if (choice === 'alt') rows = state.patients.slice();
    }
    msg.hidden = false;
    if (!rows.length) { msg.textContent = 'Không có bệnh nhân nào trong bộ lọc hiện tại để xuất.'; return; }
    const header = ['STT', 'Mã NV', 'Họ và tên', 'Loại BN', 'Trạng thái', 'Giờ khám', 'Giờ nộp hồ sơ'];
    const data = rows.map((r) => [r.stt ?? '', r.code, r.name, r.loai || '', statusText(r), r.examinedAt ? fmtTime(r.examinedAt) : '', r.submittedAt ? fmtTime(r.submittedAt) : '']);
    msg.textContent = 'Đang tạo file...';
    let blob; let name;
    try {
      if (!window.XLSX) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
      const ws = window.XLSX.utils.aoa_to_sheet([header, ...data]);
      ws['!cols'] = [{ wch: 7 }, { wch: 14 }, { wch: 28 }, { wch: 18 }, { wch: 28 }, { wch: 19 }, { wch: 19 }];
      const wb = window.XLSX.utils.book_new(); window.XLSX.utils.book_append_sheet(wb, ws, 'Danh sach');
      const ls = loaiStats(rows);   // thống kê theo Loại BN của danh sách đang xuất
      if (ls.length) {
        const total = { t: rows.length, e: rows.filter((x) => x.examinedAt).length, s: rows.filter((x) => x.submittedAt).length };   // nhân viên khám cả hai loại nằm ở cả hai nhóm nên tổng lấy theo số người
        const st = window.XLSX.utils.aoa_to_sheet([['Loại BN', 'Số bệnh nhân', 'Đã khám', 'Đã nộp hồ sơ'], ...ls.map((x) => [x.name === LOAI_BOTH ? 'Khám 2 loại' : x.name, x.total, x.examined, x.submitted]), ['Tổng số nhân viên (không trùng)', total.t, total.e, total.s]]);
        st['!cols'] = [{ wch: 20 }, { wch: 14 }, { wch: 12 }, { wch: 16 }];
        window.XLSX.utils.book_append_sheet(wb, st, 'Thong ke Loai BN');
      }
      blob = new Blob([window.XLSX.write(wb, { bookType: 'xlsx', type: 'array' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      name = exportName('xlsx');
    } catch {
      // không tải được thư viện Excel (mất mạng): xuất CSV, vẫn mở được bằng Excel
      const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
      blob = new Blob(['\ufeff' + [header, ...data].map((l) => l.map(q).join(',')).join('\r\n')], { type: 'text/csv' });
      name = exportName('csv');
    }
    const file = new File([blob], name, { type: blob.type });
    const title = `Danh sách ${rows.length.toLocaleString('vi-VN')} bệnh nhân`;
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title, text: `${title} - ${$('statusFilter').selectedOptions[0].textContent}` });
        msg.textContent = `Đã mở khung chia sẻ (${rows.length.toLocaleString('vi-VN')} dòng). Chọn Zalo để gửi.`; return;
      } catch (e) { if (e && e.name === 'AbortError') { msg.textContent = 'Đã hủy chia sẻ.'; return; } }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    msg.textContent = `Đã tải file ${name} (${rows.length.toLocaleString('vi-VN')} dòng). Thiết bị này chưa hỗ trợ chia sẻ trực tiếp: mở file trong thư mục Tải xuống rồi gửi qua Zalo.`;
  }

  function renderHistory() {
    $('history').innerHTML = state.history.map((h) =>
      `<li class="${h.kind}"><div class="h-top"><span>${fmtTime(h.time)}</span><span>${esc(h.code)}${h.stt !== '' ? ' • STT ' + esc(h.stt) : ''}</span></div><div><strong>${esc(h.name)}</strong> ${esc(h.result)}</div></li>`).join('');
  }

  // ------------------------------------------------------------ tìm và xác nhận thủ công ở tab Quét
  function quickSearch(text) {
    const kw = fold(text.trim());
    return kw ? state.patients.filter((r) => r.key.includes(kw)) : [];
  }
  function itemHtml(r) {
    const cls = r.submittedAt ? 'submitted' : r.examinedAt ? 'waiting' : '';
    const chips = (r.examinedAt ? `<span class="chip ex">✓ Khám ${fmtHour(r.examinedAt)}</span>` : '<span class="chip">Chưa đến khám</span>') +
      (r.submittedAt ? `<span class="chip sub">✓ Nộp ${fmtTime(r.submittedAt)}</span>` + (r.examinedAt ? '' : '<span class="chip wait">Chưa ghi nhận khám</span>') : r.examinedAt ? '<span class="chip wait">Chờ nộp hồ sơ</span>' : '');
    return `<li class="item ${cls}" data-code="${esc(r.code)}"><div class="name">${esc(r.name)}</div><div class="meta">${esc(r.code)} • STT ${esc(r.stt ?? '')}</div><div class="chips">${loaiChip(r)}${chips}</div></li>`;
  }
  function renderQuick() {
    const text = $('manualInput').value;
    const rows = state.loaded ? quickSearch(text) : [];
    const shown = rows.slice(0, 8);
    $('quickResults').innerHTML = shown.map(itemHtml).join('');
    const info = $('quickInfo');
    if (!text.trim()) { info.hidden = true; return; }
    info.hidden = false;
    info.textContent = !state.loaded ? 'Chưa có danh sách (vào Cài đặt để kết nối).'
      : rows.length ? `Tìm thấy ${rows.length.toLocaleString('vi-VN')} người${rows.length > shown.length ? ` — hiển thị ${shown.length}, gõ thêm để thu hẹp` : ''}. Chạm vào một người để xác nhận.` : 'Không tìm thấy ai phù hợp.';
  }
  function clearQuick() { $('manualInput').value = ''; renderQuick(); }
  async function manualSubmit() {
    const text = $('manualInput').value.trim(); if (!text) return;
    if (!state.loaded) { await handleScanned(text); return; }
    const exact = state.byCode.get(text.toUpperCase());
    if (exact) { clearQuick(); await checkout(exact.code, 'tay'); return; }       // gõ đúng cả Mã NV: ghi nhận ngay như khi quét
    const rows = quickSearch(text);
    if (rows.length === 1) { openDetail(rows[0].code); return; }                   // chỉ có một kết quả: mở để xác nhận
    if (!rows.length) {                                                            // không khớp danh sách
      if (CODE_RE.test(text) || /^https?:/i.test(text)) await handleScanned(text);  // trông như mã/link QR: xử lý như quét
      else { banner('error', 'Không tìm thấy', `Không có ai khớp "${text}" trong danh sách.`); feedback('error'); }
      return;
    }
    renderQuick();
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
      ${(() => { const t = loaiTag(r.loai); return t ? `<div class="p-tag ${t.cls}">${esc(t.text)}</div>${r.loai === LOAI_BOTH ? '<div class="meta">Kiểm tra đủ 2 bộ hồ sơ giấy: nghề nghiệp + định kỳ.</div>' : ''}` : ''; })()}
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
    if (!r.submittedAt) { $('detail').close(); await checkout(r.code, 'tay'); if (state.view === 'scan') { clearQuick(); $('manualInput').focus(); } else renderList(); return; }
    if (!await askConfirm({ title: 'Bỏ đánh dấu nộp hồ sơ', name: `${r.name} (${r.code})`, detail: `Đã nộp hồ sơ lúc ${fmtTime(r.submittedAt)}.\nTrạng thái sẽ trở về CHƯA NỘP HỒ SƠ.`, okText: 'Bỏ đánh dấu', cancelText: 'Giữ nguyên', kind: 'warning', danger: true, mascot: 'cancel' })) return;
    try {
      await rpc('unmark_submitted', withKey({ p_ma_nv: r.code, p_device: state.device }));
      r.submittedAt = null; banner('info', 'Đã bỏ đánh dấu nộp hồ sơ', `${r.name} (${r.code})`); logHistory('', r, r.code, 'Bỏ đánh dấu nộp');
      renderCards(); renderList(); renderQuick(); $('detail').close();
    } catch (e) { alert(e.message); }
  }

  // ------------------------------------------------------------ camera quét QR
  // Đọc bằng BarcodeDetector (nếu máy hỗ trợ) VÀ jsQR dự phòng: nếu bộ đọc có sẵn lỗi hoặc không đọc được thì vẫn dùng jsQR.
  let stream = null, scanning = false, detector = null, detectorFails = 0, lastText = '', lastAt = 0, decoding = false, scanTimer = null, frames = 0;
  const video = $('video'); const canvas = $('canvas');

  async function makeDetector() {
    if (!('BarcodeDetector' in window)) return null;
    try {
      const formats = await BarcodeDetector.getSupportedFormats?.();
      if (formats && !formats.includes('qr_code')) return null;
      return new BarcodeDetector({ formats: ['qr_code'] });
    } catch { return null; }
  }

  let jsQRLoading = null;
  function ensureJsQR() {                                               // thư viện chưa tải được từ CDN chính thì thử CDN dự phòng
    if (typeof jsQR === 'function') return Promise.resolve(true);
    jsQRLoading ||= new Promise((resolve) => {
      const el = document.createElement('script'); el.src = 'https://unpkg.com/jsqr@1.4.0/dist/jsQR.js';
      el.onload = () => resolve(typeof jsQR === 'function'); el.onerror = () => resolve(false); document.head.appendChild(el);
    });
    return jsQRLoading;
  }

  /** Đọc mã QR từ một khung hình (video hoặc canvas). Trả về nội dung mã hoặc null. */
  async function decodeSource(source) {
    const sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
    if (!sw || !sh) return null;
    if (detector) {
      try { const codes = await detector.detect(source); if (codes.length) return codes[0].rawValue; detectorFails = 0; }
      catch { if (++detectorFails >= 5) detector = null; }            // lỗi liên tục: bỏ bộ đọc có sẵn, chỉ dùng jsQR
    }
    if (typeof jsQR !== 'function') return null;
    const scale = Math.min(1, 800 / sw); const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(source, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const code = jsQR(img.data, w, h, { inversionAttempts: 'attemptBoth' });   // cả mã đen trên nền sáng lẫn mã sáng trên nền tối
    return code ? code.data : null;
  }

  function onDecoded(text) {
    const now = Date.now();
    if (state.popupOpen) return;                                        // đang hiện popup: tạm dừng nhận mã mới
    if (text === lastText && now - lastAt < 3000) return;               // bỏ qua mã vừa quét (còn trong khung hình)
    lastText = text; lastAt = now;
    handleScanned(text);
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) { $('scanHint').textContent = 'Trình duyệt không hỗ trợ camera (cần mở bằng HTTPS, dùng Chrome/Safari).'; return; }
    try {
      $('scanHint').textContent = 'Đang bật camera...';
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      video.srcObject = stream; await video.play();
      detector = await makeDetector(); detectorFails = 0;
      const lib = await ensureJsQR();
      if (!detector && !lib) { $('scanHint').textContent = 'Không tải được thư viện đọc QR (kiểm tra mạng). Bạn vẫn có thể nhập mã thủ công bên dưới.'; }
      scanning = true; frames = 0; $('scanbox').classList.remove('idle');
      $('btnCamera').textContent = 'Tắt camera';
      if (detector || lib) $('scanHint').textContent = 'Đưa mã QR vào khung';
      const track = stream.getVideoTracks()[0]; const caps = track.getCapabilities?.() || {};
      $('btnTorch').hidden = !caps.torch;
      try { audioCtx ||= new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume?.(); } catch { /* không có âm thanh */ }
      loop();
    } catch (e) {
      $('scanHint').textContent = e.name === 'NotAllowedError' ? 'Chưa cho phép dùng camera. Hãy cấp quyền camera cho trang web.'
        : e.name === 'NotFoundError' ? 'Không tìm thấy camera trên thiết bị.' : `Không bật được camera: ${e.message}`;
    }
  }
  function stopCamera() {
    scanning = false; clearTimeout(scanTimer);
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    video.srcObject = null; $('scanbox').classList.add('idle'); $('btnTorch').hidden = true;
    $('btnCamera').textContent = 'Bật camera'; $('scanHint').textContent = 'Bấm “Bật camera” để quét mã QR';
  }
  // Dùng setTimeout thay cho requestAnimationFrame để vòng quét không bị trình duyệt di động làm chậm hoặc dừng.
  async function loop() {
    if (!scanning) return;
    if (video.readyState >= 2 && !decoding) {
      decoding = true;
      try { frames++; const text = await decodeSource(video); if (text) onDecoded(text); }
      catch { /* bỏ qua frame lỗi */ } finally { decoding = false; }
    }
    if (scanning) scanTimer = setTimeout(loop, 120);
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
    $('version').textContent = `Phiên bản ${APP_VERSION} • Product by Tồ Lô team`;
    $('dateValue').value = dayKey(new Date());
    document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
    $('btnCamera').addEventListener('click', () => (scanning ? stopCamera() : startCamera()));
    $('btnTorch').addEventListener('click', toggleTorch);
    $('btnUndo').addEventListener('click', undoSubmitted);
    $('popupOk').addEventListener('click', closePopup);
    $('popupUndo').addEventListener('click', () => { closePopup(); undoSubmitted(); });
    $('popup').addEventListener('click', (e) => { if (e.target === $('popup')) closePopup(); });        // chạm ra ngoài để đóng
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.popupOpen) closePopup(); });
    $('manualForm').addEventListener('submit', async (e) => { e.preventDefault(); await manualSubmit(); });
    $('manualInput').addEventListener('input', (e) => {
      const v = e.target.value.trim();
      if (v.length > 30 || /^https?:\/\//i.test(v)) { e.target.value = ''; renderQuick(); handleScanned(v); return; }   // máy quét Bluetooth: dán nguyên chuỗi dài
      renderQuick();
    });
    $('quickResults').addEventListener('click', (e) => { const li = e.target.closest('.item'); if (li) openDetail(li.dataset.code); });
    $('btnEye').addEventListener('click', () => {
      const input = $('setAccess'); const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      $('btnEye').setAttribute('aria-pressed', String(show)); $('btnEye').setAttribute('aria-label', show ? 'Ẩn mã truy cập' : 'Hiện mã truy cập');
      document.querySelector('.eye-on').hidden = show; document.querySelector('.eye-off').hidden = !show;
    });
    const refreshList = refreshAll;
    for (const id of ['search', 'statusFilter', 'dateOn', 'dateBasis', 'dateValue']) $(id).addEventListener('input', refreshList);
    $('btnToday').addEventListener('click', () => { $('dateValue').value = dayKey(new Date()); $('dateOn').checked = true; refreshList(); });
    const stepDay = (delta) => { const cur = $('dateValue').value ? new Date($('dateValue').value + 'T00:00:00') : new Date(); cur.setDate(cur.getDate() + delta); $('dateValue').value = dayKey(cur); $('dateOn').checked = true; refreshList(); };
    $('cards').addEventListener('click', (e) => {
      const el = e.target.closest('.card[data-card]'); if (!el) return;
      const pill = e.target.closest('.pill[data-loai]');
      applyCardFilter(el.dataset.card, pill ? pill.dataset.loai : null, !!e.target.closest('.dayzone'));
    });
    $('btnPrevDay').addEventListener('click', () => stepDay(-1));
    $('btnNextDay').addEventListener('click', () => stepDay(1));
    $('basisSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-basis]'); if (!b) return;
      setBasis(b.dataset.basis);
      $('dateOn').checked = true; refreshList();
    });
    $('btnExport').addEventListener('click', exportList);
    $('btnMore').addEventListener('click', () => { state.shown += CFG.pageSize || 60; renderList(); });
    $('list').addEventListener('click', (e) => { const li = e.target.closest('.item'); if (li) openDetail(li.dataset.code); });
    $('detailClose').addEventListener('click', () => $('detail').close());
    $('detailAction').addEventListener('click', detailAction);
    $('btnSave').addEventListener('click', saveSettings);
    $('btnLogout').addEventListener('click', async () => {
      if (!await askConfirm({ title: 'Xóa mã truy cập', name: 'Mã truy cập trên điện thoại này', detail: 'Bạn sẽ phải nhập lại mã để dùng tiếp.', okText: 'Xóa mã', cancelText: 'Giữ lại', kind: 'warning', danger: true })) return;
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
  window.__app = { state, handleScanned, checkout, loadAll, pollOnce, decodeSource, onDecoded, makeDetector, ensureJsQR };      // phục vụ kiểm thử
})();

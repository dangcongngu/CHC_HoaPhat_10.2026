/* Lượm Lúa - Tìm hồ sơ: hiển thị trực tiếp các số thứ tự mà màn hình Check-in cần tìm hồ sơ.
 * Dùng chung database Supabase (hàm get_find_requests / set_find_found / cancel_find). Không có máy chủ riêng.
 * Mã truy cập dùng chung với web nộp hồ sơ (cùng lưu trong trình duyệt, khóa "ll.access"). */
(() => {
  'use strict';
  const CFG = window.APP_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem('ll.' + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem('ll.' + key, JSON.stringify(value)); } catch { /* bỏ qua */ } },
    del(key) { try { localStorage.removeItem('ll.' + key); } catch { /* bỏ qua */ } }
  };

  const state = {
    url: store.get('override', null)?.url || CFG.supabaseUrl || '',
    key: store.get('override', null)?.key || CFG.supabasePublishableKey || '',
    access: store.get('access', ''),
    device: store.get('device', 'Điện thoại ' + Math.floor(100 + Math.random() * 900)),
    items: new Map(),            // id -> yêu cầu
    cursor: null,
    filter: 'todo',
    term: '',
    sound: store.get('findSound', true),
    loaded: false,
    online: false,
    fresh: new Set()
  };
  store.set('device', state.device);

  class NetError extends Error {}
  class ApiError extends Error {}
  const pad = (n) => String(n).padStart(2, '0');
  const fmtHour = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();

  // ------------------------------------------------------------ gọi Supabase
  async function rpc(fn, args) {
    if (!state.url || !state.key || !state.access) throw new ApiError('Chưa nhập mã truy cập.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let res;
    try {
      res = await fetch(`${state.url.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
        method: 'POST', headers: { apikey: state.key, 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal: controller.signal
      });
    } catch (e) {
      throw new NetError(e.name === 'AbortError' ? 'Máy chủ không phản hồi.' : 'Không có kết nối mạng.');
    } finally { clearTimeout(timer); }
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch { /* không phải JSON */ }
    if (!res.ok) {
      if (data?.code === 'PGRST202') throw new ApiError('Chưa bật chức năng “Tìm hồ sơ” trên Dữ liệu Cloud (quản trị viên cần chạy file supabase/find_requests.sql).');
      throw new ApiError(data?.message || `Lỗi máy chủ (HTTP ${res.status}).`);
    }
    return data;
  }
  const withKey = (extra = {}) => ({ p_key: state.access, ...extra });

  function setConn(kind, text) { $('conn').className = 'conn ' + kind; $('connText').textContent = text; }
  let toastTimer;
  function toast(text) {
    const t = $('toast'); t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // ------------------------------------------------------------ âm báo
  let audioCtx;
  function beep() {
    if (!state.sound) return;
    try {
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      [[880, 0], [1175, 0.16]].forEach(([f, s]) => {
        const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
        o.frequency.value = f; g.gain.value = 0.2; o.connect(g); g.connect(audioCtx.destination);
        const t = audioCtx.currentTime + s; o.start(t); o.stop(t + 0.14);
      });
      navigator.vibrate?.(120);
    } catch { /* thiết bị không hỗ trợ */ }
  }

  // ------------------------------------------------------------ dữ liệu
  const toItem = (d) => ({
    id: d.id, code: String(d.ma_nv || '').toUpperCase(), stt: d.stt, name: d.ho_ten || '',
    at: new Date(d.requested_at), found: !!d.is_found, foundAt: d.found_at ? new Date(d.found_at) : null,
    foundBy: d.found_by || '', cancelled: !!d.cancelled, by: d.requested_by || ''
  });

  function apply(rows) {
    let announce = false;
    for (const d of rows) {
      const it = toItem(d); const old = state.items.get(it.id);
      if (it.cancelled) { state.items.delete(it.id); continue; }
      if (state.loaded && !it.found && (!old || old.found || it.at > old.at)) { announce = true; state.fresh.add(it.id); }
      state.items.set(it.id, it);
    }
    if (announce) beep();
    return rows.length > 0;
  }

  let timer;
  async function tick() {
    clearTimeout(timer);
    let next = document.hidden ? 8000 : Math.max(1, CFG.findPollSeconds || 2) * 1000;
    try {
      const snap = await rpc('get_find_requests', withKey({ p_since: state.cursor }));
      const changed = apply(snap.rows || []);
      state.loaded = true;
      const server = new Date(snap.server_time);
      state.cursor = new Date(server.getTime() - 10000).toISOString();     // chồng 10 giây để không sót thay đổi
      state.online = true; setConn('ok', 'Trực tiếp');
      if (changed || !$('listArea').dataset.ready) { $('listArea').dataset.ready = '1'; render(); }
    } catch (e) {
      state.online = false;
      if (e instanceof ApiError) { setConn('bad', 'Lỗi'); $('sub').textContent = e.message; next = 10000; }
      else { setConn('bad', 'Mất mạng'); next = 4000; }
    }
    timer = setTimeout(tick, next);
  }

  // ------------------------------------------------------------ hiển thị
  const sortItems = (arr) => arr.sort((a, b) => (a.found - b.found) || (b.at - a.at));

  function waitText(it) {
    const mins = Math.floor((Date.now() - it.at.getTime()) / 60000);
    return mins < 1 ? 'vừa phát' : mins < 60 ? `đã chờ ${mins} phút` : `đã chờ ${Math.floor(mins / 60)} giờ ${mins % 60} phút`;
  }

  function renderHero(all) {
    const hero = $('hero');
    const latest = [...all].sort((a, b) => b.at - a.at)[0];
    const todo = all.filter((x) => !x.found);
    const head = todo.sort((a, b) => b.at - a.at)[0] || latest;
    hero.hidden = false;
    if (!head) { hero.className = 'hero idle'; $('heroLabel').textContent = 'Chưa có hồ sơ cần tìm'; $('heroStt').textContent = '—'; $('heroName').textContent = ''; $('heroMeta').textContent = 'Khi Check-in tìm một hồ sơ, số thứ tự sẽ hiện ở đây.'; return; }
    const wasId = hero.dataset.id;
    hero.className = 'hero ' + (head.found ? 'done' : 'todo');
    $('heroLabel').textContent = head.found ? 'Đã tìm thấy hồ sơ' : todo.length > 1 ? `Cần tìm hồ sơ (còn ${todo.length} hồ sơ chưa tìm thấy)` : 'Cần tìm hồ sơ';
    $('heroStt').textContent = head.stt ?? '?';
    $('heroName').textContent = head.name;
    $('heroMeta').textContent = `Mã NV: ${head.code}  •  phát lúc ${fmtHour(head.at)}${head.found ? '' : '  •  ' + waitText(head)}`;
    if (String(head.id) !== wasId || state.fresh.has(head.id)) { hero.dataset.id = String(head.id); if (!head.found) { hero.classList.remove('pulse'); void hero.offsetWidth; hero.classList.add('pulse'); } }
  }

  function render() {
    const all = [...state.items.values()];
    const todo = all.filter((x) => !x.found).length;
    $('cTodo').textContent = todo; $('cDone').textContent = all.length - todo; $('cAll').textContent = all.length;
    document.title = (todo ? `(${todo}) ` : '') + 'Tìm hồ sơ - Lượm Lúa';
    $('sub').textContent = todo ? `${todo} hồ sơ chưa tìm thấy` : 'Không còn hồ sơ cần tìm';
    renderHero(all);

    const term = fold(state.term);
    let rows = all.filter((x) => state.filter === 'all' || (state.filter === 'todo') === !x.found);
    if (term) rows = rows.filter((x) => fold(`${x.stt}|${x.code}|${x.name}`).includes(term));
    sortItems(rows);
    $('list').innerHTML = rows.map((x) => `
      <li class="item ${x.found ? 'done' : 'todo'}${state.fresh.has(x.id) ? ' fresh' : ''}" data-id="${x.id}">
        <div class="stt"><small>STT</small><strong>${esc(x.stt ?? '?')}</strong></div>
        <div class="info">
          <div class="nm">${esc(x.name)}</div>
          <div class="sub">Mã NV: ${esc(x.code)} • phát lúc ${fmtHour(x.at)}</div>
          <div class="st">${x.found ? `✓ Đã tìm thấy${x.foundAt ? ' lúc ' + fmtHour(x.foundAt) : ''}` : '● Chưa tìm thấy • ' + waitText(x)}</div>
        </div>
        <div class="acts">
          <button class="tick" data-act="tick">${x.found ? '✓ Đã thấy' : 'Đã tìm thấy'}</button>
          ${x.found ? '' : '<button class="x" data-act="cancel" title="Hủy yêu cầu phát nhầm">Hủy</button>'}
        </div>
      </li>`).join('');
    state.fresh.clear();
    const empty = $('empty');
    empty.hidden = rows.length > 0;
    if (!rows.length) empty.textContent = term ? 'Không có hồ sơ nào khớp.' : state.filter === 'todo' ? 'Không còn hồ sơ nào cần tìm. 🎉' : state.filter === 'done' ? 'Chưa có hồ sơ nào được tìm thấy.' : 'Chưa có yêu cầu nào.';
  }

  // ------------------------------------------------------------ thao tác
  async function toggleFound(id) {
    const it = state.items.get(id); if (!it) return;
    const want = !it.found;
    it.found = want; it.foundAt = want ? new Date() : null; render();         // hiện ngay, lỗi thì hoàn lại
    try { await rpc('set_find_found', withKey({ p_id: id, p_found: want, p_device: state.device })); }
    catch (e) { it.found = !want; it.foundAt = null; render(); toast(e.message || 'Không lưu được, thử lại.'); }
  }
  async function cancel(id) {
    const it = state.items.get(id); if (!it) return;
    if (!confirm(`Hủy yêu cầu tìm hồ sơ STT ${it.stt} - ${it.name}?`)) return;
    state.items.delete(id); render();
    try { await rpc('cancel_find', withKey({ p_id: id, p_device: state.device })); }
    catch (e) { state.items.set(id, it); render(); toast(e.message || 'Không hủy được, thử lại.'); }
  }

  // ------------------------------------------------------------ giao diện / cài đặt
  function showSetup(show) {
    $('setup').hidden = !show; $('hero').hidden = show; $('listArea').hidden = show;
    if (show) { $('accessInput').value = ''; $('deviceInput').value = state.device; $('setupMsg').textContent = ''; }
  }
  function startUi() { showSetup(false); $('listArea').hidden = false; $('hero').hidden = false; tick(); }

  $('btnSave').addEventListener('click', async () => {
    const previous = state.access;
    const access = $('accessInput').value.trim() || previous; const device = $('deviceInput').value.trim();
    if (!access) { $('setupMsg').textContent = 'Vui lòng nhập mã truy cập.'; return; }
    state.access = access; if (device) state.device = device;
    try { await rpc('get_find_requests', withKey({ p_since: new Date().toISOString() })); }
    catch (e) { state.access = previous; $('setupMsg').textContent = e.message; return; }
    store.set('access', access); store.set('device', state.device);
    state.cursor = null; state.items.clear(); state.loaded = false; $('listArea').dataset.ready = '';
    startUi();
  });
  $('btnForget').addEventListener('click', () => { store.del('access'); state.access = ''; clearTimeout(timer); setConn('wait', 'Chưa có mã'); showSetup(true); });
  $('btnSettings').addEventListener('click', () => { clearTimeout(timer); showSetup(true); });
  $('btnSound').addEventListener('click', () => { state.sound = !state.sound; store.set('findSound', state.sound); $('btnSound').classList.toggle('off', !state.sound); toast(state.sound ? 'Đã bật âm báo' : 'Đã tắt âm báo'); if (state.sound) beep(); });
  $('btnSound').classList.toggle('off', !state.sound);
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === b)); state.filter = b.dataset.f; render();
  }));
  $('q').addEventListener('input', (e) => { state.term = e.target.value; render(); });
  $('list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const id = Number(btn.closest('.item').dataset.id);
    if (btn.dataset.act === 'tick') toggleFound(id); else cancel(id);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.access) tick(); });
  setInterval(() => { if (state.loaded) render(); }, 30000);                    // cập nhật "đã chờ ... phút"

  // Giữ màn hình sáng để theo dõi liên tục (nếu trình duyệt hỗ trợ)
  async function keepAwake() { try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch { /* bỏ qua */ } }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) keepAwake(); });
  keepAwake();

  if (state.access) startUi(); else { setConn('wait', 'Chưa có mã'); showSetup(true); }
})();

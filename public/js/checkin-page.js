/* Door check-in: checkin.html?code=… (opened by scanning a ticket) or checkin.html?event=ID (scanner for one event). */
(function () {
  'use strict';
  const { api, esc, formatDate, toast, setMessage, money } = CC;
  const $ = id => document.getElementById(id);
  const p = CC.params();
  let stream = null, scanning = false, lastCode = '', lastAt = 0, detector = null;
  let events = [];

  const canVibrate = () => !!navigator.vibrate && !!(navigator.userActivation && navigator.userActivation.hasBeenActive);
  const codeFrom = text => {
    const s = String(text || '').trim();
    const m = /[?&]code=([a-f0-9]{24})/i.exec(s) || /^([a-f0-9]{24})$/i.exec(s);
    return m ? m[1].toLowerCase() : '';
  };

  function showResult(kind, title, html) {
    const box = $('checkinResult');
    box.className = `checkin-result is-${kind}`;
    box.innerHTML = `<span class="result-icon" aria-hidden="true">${{ ok: '✓', warn: '!', bad: '✕' }[kind]}</span><div><strong>${esc(title)}</strong>${html || ''}</div>`;
    box.classList.remove('hidden');
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function checkIn(raw) {
    const code = codeFrom(raw);
    if (!code) return showResult('bad', 'Not a Community Connect ticket', '<p>This QR code or text is not a valid ticket code.</p>');
    try {
      const d = await api(`/checkin/${code}`, { method: 'POST' });
      const t = d.ticket;
      const time = t.checked_in_at ? new Date(`${t.checked_in_at.replace(' ', 'T')}Z`).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
      showResult(d.already ? 'warn' : 'ok', d.already ? `Already checked in${time ? ` at ${time}` : ''}` : `Welcome, ${t.holder_name}!`,
        `<p><b>${esc(t.holder_name)}</b> · ${esc(t.event_name)} · ${esc(CC.ticketLabel(t.ticket_type))}${t.amount_pence ? ` ${money(t.amount_pence)}` : ''}<br><small>${esc(t.ticket_number)} · ${esc(formatDate(t.event_date))} ${esc(t.event_time)}</small></p>
         <p class="result-count">${d.stats.checked_in} of ${d.stats.registered} checked in</p>`);
      if (canVibrate()) navigator.vibrate(d.already ? [80, 60, 80] : 120);
      if ($('eventPick').value !== String(t.event_id)) { $('eventPick').value = String(t.event_id); }
      loadEventStats();
    } catch (err) {
      if (err.status === 401) return needLogin();
      const title = err.code === 'NOT_YOUR_EVENT' ? 'Ticket for another organizer\'s event' : err.code === 'CHECKIN_NOT_OPEN' ? 'Check-in not open yet' : 'Ticket not valid';
      showResult('bad', title, `<p>${esc(err.message)}</p>`);
      if (canVibrate()) navigator.vibrate([200, 80, 200]);
    }
  }

  // ---------- camera scanner (BarcodeDetector, built into Chrome, Edge and Android browsers) ----------
  async function startScan() {
    if (!('BarcodeDetector' in window)) {
      $('scanSupport').textContent = 'This browser cannot scan with the camera. Use your phone\'s camera app to scan the QR code (it opens this page), or type the code.';
      return;
    }
    try {
      detector = detector || new window.BarcodeDetector({ formats: ['qr_code'] });
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch (err) {
      $('scanSupport').textContent = err.name === 'NotAllowedError' ? 'Camera permission was blocked. Allow the camera in the address bar and try again.' : 'No camera could be opened on this device.';
      return;
    }
    const video = $('scanVideo');
    video.srcObject = stream;
    await video.play();
    scanning = true;
    $('scannerFrame').classList.add('is-live');
    $('startScan').classList.add('hidden'); $('stopScan').classList.remove('hidden');
    $('scanSupport').textContent = 'Point the camera at the QR code on the ticket.';
    loop();
  }
  async function loop() {
    if (!scanning) return;
    try {
      const codes = await detector.detect($('scanVideo'));
      const value = codes[0] && codes[0].rawValue;
      if (value && (value !== lastCode || Date.now() - lastAt > 4000)) {
        lastCode = value; lastAt = Date.now();
        await checkIn(value);
      }
    } catch { /* frame not ready */ }
    setTimeout(loop, 300);
  }
  function stopScan() {
    scanning = false;
    stream?.getTracks().forEach(t => t.stop());
    stream = null;
    $('scannerFrame').classList.remove('is-live');
    $('startScan').classList.remove('hidden'); $('stopScan').classList.add('hidden');
  }

  // ---------- event picker and live counts ----------
  async function loadEvents() {
    try {
      events = (await api('/organizer/events')).events.filter(e => !e.is_past || e.checkin_open).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    } catch { events = []; }
    const now = events.filter(e => e.checkin_open && !e.is_past);
    $('eventPick').innerHTML = '<option value="">Choose one of your events…</option>' + events.filter(e => !e.is_past).map(e =>
      `<option value="${e.id}">${esc(e.name)} — ${esc(formatDate(e.event_date, { short: true }))} ${esc(e.event_time)}${e.checkin_open ? ' · check-in open' : ''}</option>`).join('');
    const want = p.get('event') || (now[0] && now[0].id);
    if (want) $('eventPick').value = String(want);
    loadEventStats();
  }
  async function loadEventStats() {
    const id = $('eventPick').value;
    if (!id) { $('eventStats').innerHTML = ''; $('recentList').innerHTML = ''; return; }
    try {
      const { event: e, attendees } = await api(`/events/${id}/attendees`);
      const done = attendees.filter(a => a.attended);
      const pct = attendees.length ? Math.round(done.length / attendees.length * 100) : 0;
      $('eventStats').innerHTML = `<div class="stat-row"><b>${done.length}</b><span>of ${attendees.length} checked in</span></div>
        <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Checked in"><span style="width:${pct}%"></span></div>
        <small class="muted">${e.checkin_open ? 'Check-in is open.' : 'Check-in opens 36 hours before the event starts.'}</small>`;
      const recent = done.slice().sort((a, b) => String(b.checked_in_at).localeCompare(String(a.checked_in_at))).slice(0, 6);
      $('recentList').innerHTML = recent.length ? `<h3>Recently checked in</h3>${recent.map(a => `<div class="recent-item"><span>✓ ${esc(a.name)}</span><small>${a.checked_in_at ? new Date(`${a.checked_in_at.replace(' ', 'T')}Z`).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''}</small></div>`).join('')}` : '';
    } catch (err) { $('eventStats').innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
  }

  // ---------- login ----------
  function needLogin(message) {
    $('checkinTools').classList.add('hidden');
    $('checkinLogin').classList.remove('hidden');
    if (message) setMessage($('ciLoginMsg'), message, 'error');
    $('ciEmail').focus();
    CC.mountGoogle($('ciGoogle'), { getRole: () => 'organizer', onAuthed: () => ready(), onError: msg => setMessage($('ciLoginMsg'), msg, 'error') });
  }
  async function ready() {
    Detail.renderAccount(start);
    const u = CC.user;
    if (!u) return needLogin(p.get('code') ? 'Log in as the event organizer to check this ticket in.' : '');
    if (u.role !== 'organizer') return needLogin('This is a participant account. Only the event organizer can check tickets in. Show your QR code to them at the door.');
    $('checkinLogin').classList.add('hidden');
    $('checkinTools').classList.remove('hidden');
    $('scanSupport').textContent = 'BarcodeDetector' in window ? '' : 'Tip: this browser cannot use the camera scanner — scan with your phone camera app instead, or type the code.';
    await loadEvents();
    const code = p.get('code');
    if (code) {
      await checkIn(code);
      history.replaceState(null, '', 'checkin.html');
    }
  }
  async function start() { try { await CC.loadUser(); } catch { /* offline */ } await ready(); }

  $('checkinLoginForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('ciLoginBtn').disabled = true;
    setMessage($('ciLoginMsg'), 'Signing in…');
    try {
      const d = await api('/auth/login', { method: 'POST', body: { email: $('ciEmail').value.trim(), password: $('ciPassword').value, role: 'organizer' } });
      CC.setSession(d.token, d.user);
      setMessage($('ciLoginMsg'), '');
      toast(`Welcome back, ${d.user.name.split(' ')[0]}.`, 'success');
      await ready();
    } catch (err) { setMessage($('ciLoginMsg'), err.message, 'error'); }
    finally { $('ciLoginBtn').disabled = false; }
  });
  $('manualForm').addEventListener('submit', e => { e.preventDefault(); checkIn($('manualCode').value); $('manualCode').value = ''; });
  $('startScan').onclick = startScan;
  $('stopScan').onclick = stopScan;
  $('eventPick').onchange = loadEventStats;
  window.addEventListener('pagehide', stopScan);
  setInterval(() => { if (!document.hidden && $('eventPick').value) loadEventStats(); }, 15000);
  start();
})();

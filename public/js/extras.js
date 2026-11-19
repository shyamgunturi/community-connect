/* Community Connect v5 — shared extras used on every page:
 * status badges, share buttons, QR e-tickets (modal + download), "bring a friend" referral links
 * and the notifications bell in the header. Needs common.js and qr.js first. */
(function () {
  'use strict';
  const { esc, api, money, formatDate, toast } = CC;

  // ---------- badges ----------
  const BADGE = {
    featured: ['★ Featured', 'b-featured'], flash_sale: ['⚡ Flash sale', 'b-flash'], sold_out: ['Sold out', 'b-sold'],
    few_left: ['', 'b-few'], selling_fast: ['🔥 Selling fast', 'b-hot'], new: ['✦ New', 'b-new']
  };
  function badges(e, max = 3) {
    const list = (e.badges || []).slice(0, max);
    if (!list.length) return '';
    return `<div class="cc-badges">${list.map(b => {
      const [label, cls] = BADGE[b] || [b, ''];
      const text = b === 'few_left' ? `Only ${e.spots_left} left` : b === 'flash_sale' && e.flash_percent ? `⚡ ${e.flash_percent}% off` : label;
      return `<span class="cc-badge ${cls}">${esc(text)}</span>`;
    }).join('')}</div>`;
  }

  // ---------- sharing ----------
  function shareBar(url, text, { label = 'Share' } = {}) {
    const u = encodeURIComponent(url), t = encodeURIComponent(text);
    return `<div class="share-bar" data-share-url="${esc(url)}" data-share-text="${esc(text)}">
      <span class="share-label">${esc(label)}</span>
      <a class="share-btn s-wa" href="https://wa.me/?text=${t}%20${u}" target="_blank" rel="noopener" aria-label="Share on WhatsApp">WhatsApp</a>
      <a class="share-btn s-fb" href="https://www.facebook.com/sharer/sharer.php?u=${u}" target="_blank" rel="noopener" aria-label="Share on Facebook">Facebook</a>
      <a class="share-btn s-x" href="https://twitter.com/intent/tweet?text=${t}&amp;url=${u}" target="_blank" rel="noopener" aria-label="Share on X">X</a>
      <a class="share-btn s-li" href="https://www.linkedin.com/sharing/share-offsite/?url=${u}" target="_blank" rel="noopener" aria-label="Share on LinkedIn">LinkedIn</a>
      <button class="share-btn s-copy" type="button" data-share-copy>🔗 Copy link</button>
      ${navigator.share ? '<button class="share-btn s-more" type="button" data-share-native>More…</button>' : ''}
    </div>`;
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove(); return ok;
    }
  }
  document.addEventListener('click', async ev => {
    const btn = ev.target.closest('[data-share-copy],[data-share-native],[data-copy]');
    if (!btn) return;
    const bar = btn.closest('[data-share-url]');
    const url = btn.dataset.copy || bar?.dataset.shareUrl || location.href;
    if (btn.hasAttribute('data-share-native')) {
      try { await navigator.share({ title: document.title, text: bar?.dataset.shareText || '', url }); } catch { /* user closed the sheet */ }
      return;
    }
    const ok = await copyText(url);
    toast(ok ? 'Link copied — paste it anywhere to share.' : url, ok ? 'success' : 'info');
    if (ok) { const old = btn.textContent; btn.textContent = '✓ Copied'; setTimeout(() => { btn.textContent = old; }, 1600); }
  });

  // ---------- referrals ("bring a friend") ----------
  const REF_KEY = id => `cc_ref_${id}`;
  const referral = {
    /** Saves ?ref=CODE from the URL for this event so it survives logging in / joining. */
    capture(eventId) {
      const r = (CC.params().get('ref') || '').trim().toLowerCase();
      if (/^[a-f0-9]{8}$/.test(r)) { try { sessionStorage.setItem(REF_KEY(eventId), r); } catch { /* storage off */ } }
      return referral.get(eventId);
    },
    get(eventId) { try { return sessionStorage.getItem(REF_KEY(eventId)) || ''; } catch { return ''; } },
    clear(eventId) { try { sessionStorage.removeItem(REF_KEY(eventId)); } catch { /* storage off */ } },
    link(eventId, code) { return `${location.origin}/event.html?id=${eventId}&ref=${encodeURIComponent(code)}`; }
  };

  // ---------- QR e-tickets ----------
  const checkinUrl = code => `${location.origin}/checkin.html?code=${encodeURIComponent(code)}`;
  const qrSvg = (code, size = 220) => window.CCQR ? CCQR.svg(checkinUrl(code), { size, margin: 4, label: 'Ticket QR code' }) : '';

  function downloadQr(code, name) {
    const blob = new Blob([CCQR.svg(checkinUrl(code), { size: 600, margin: 4 })], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ticket-${String(name || 'event').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}.svg`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /** Ticket card with the QR code. t = { code, event_name, community_name, event_date, event_time, venue, holder, ticket_number, ticket_type, amount_pence, checked_in, checked_in_at } */
  function ticketCard(t) {
    return `<div class="qr-ticket${t.checked_in ? ' is-used' : ''}">
      <div class="qr-ticket-code">${qrSvg(t.code)}${t.checked_in ? '<span class="qr-stamp">✓ Checked in</span>' : ''}</div>
      <div class="qr-ticket-info">
        <small>${esc(t.community_name || 'Community Connect')}</small>
        <strong>${esc(t.event_name)}</strong>
        <span>📅 ${esc(formatDate(t.event_date))} · ◷ ${esc(t.event_time)}</span>
        ${t.venue ? `<span>⌖ ${esc(t.venue)}</span>` : ''}
        ${t.holder ? `<span>👤 ${esc(t.holder)}</span>` : ''}
        <span class="qr-ticket-meta">${t.ticket_number ? `${esc(t.ticket_number)} · ` : ''}${CC.ticketLabel(t.ticket_type)}${t.amount_pence ? ` · ${money(t.amount_pence)}` : ''}</span>
        <code class="qr-code-text" title="Ticket code">${esc(t.code)}</code>
        <p class="qr-help">${t.checked_in ? 'This ticket has been used to check in.' : 'Show this QR code at the door. The organizer scans it to check you in.'}</p>
      </div>
    </div>`;
  }

  let lastFocus = null;
  function openTicket(t) {
    closeTicket();
    lastFocus = document.activeElement;
    const wrap = document.createElement('div');
    wrap.className = 'ticket-modal'; wrap.id = 'ticketModal';
    wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); wrap.setAttribute('aria-label', 'Your e-ticket');
    wrap.innerHTML = `<div class="ticket-modal-card"><button class="auth-close" type="button" data-ticket-close aria-label="Close">×</button>
      <p class="eyebrow">YOUR E-TICKET</p>${ticketCard(t)}
      <div class="detail-actions"><button class="primary-btn" type="button" data-ticket-download>⬇ Download QR</button><button class="outline-btn" type="button" data-ticket-print>🖨 Print</button><button class="outline-btn" type="button" data-ticket-close>Close</button></div></div>`;
    document.body.appendChild(wrap);
    document.body.classList.add('modal-open');
    wrap.querySelector('[data-ticket-download]').onclick = () => downloadQr(t.code, t.event_name);
    wrap.querySelector('[data-ticket-print]').onclick = () => window.print();
    wrap.addEventListener('click', e => { if (e.target === wrap || e.target.closest('[data-ticket-close]')) closeTicket(); });
    wrap.querySelector('[data-ticket-close]').focus();
  }
  function closeTicket() {
    const m = document.getElementById('ticketModal');
    if (!m) return;
    m.remove(); document.body.classList.remove('modal-open');
    lastFocus?.focus?.();
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeTicket(); closeBell(); } });

  /** Ticket fields from an event object returned by the API (participant view). */
  const ticketFromEvent = e => e.my_ticket && e.my_ticket.ticket_code ? {
    code: e.my_ticket.ticket_code, event_name: e.name, community_name: e.community_name, event_date: e.event_date, event_time: e.event_time,
    venue: e.venue, holder: CC.user?.name, ticket_number: CC.user ? `CC-${String(e.id).padStart(4, '0')}-${String(CC.user.id).padStart(5, '0')}` : '',
    ticket_type: e.my_ticket.ticket_type, amount_pence: e.my_ticket.amount_pence, checked_in: e.my_ticket.checked_in, checked_in_at: e.my_ticket.checked_in_at
  } : null;

  // ---------- notifications bell ----------
  const ICONS = { ticket: '🎟️', referral: '🤝', waitlist_offer: '🎉', flash_sale: '⚡', new_event: '📅', reminder: '⏰', checked_in: '✅' };
  let bellTimer = null, bellData = { notifications: [], unread: 0 };
  function ago(sqlUtc) {
    const t = new Date(`${String(sqlUtc).replace(' ', 'T')}Z`).getTime();
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  }
  function bellEl() {
    let wrap = document.getElementById('ccBell');
    if (wrap) return wrap;
    const header = document.querySelector('.site-header');
    if (!header) return null;
    wrap = document.createElement('div');
    wrap.id = 'ccBell'; wrap.className = 'bell-wrap hidden';
    wrap.innerHTML = `<button class="bell-btn" type="button" aria-label="Notifications" aria-haspopup="true" aria-expanded="false" id="bellBtn"><span aria-hidden="true">🔔</span><span class="bell-count hidden" id="bellCount">0</span></button>
      <div class="bell-panel hidden" id="bellPanel" role="region" aria-label="Notifications"><div class="bell-head"><strong>Notifications</strong><button class="text-btn" type="button" id="bellReadAll">Mark all read</button></div><div class="bell-list" id="bellList"></div></div>`;
    header.insertBefore(wrap, header.querySelector('.header-account'));
    wrap.querySelector('#bellBtn').onclick = () => { const open = wrap.querySelector('#bellPanel').classList.contains('hidden'); if (open) openBell(); else closeBell(); };
    wrap.querySelector('#bellReadAll').onclick = async () => { try { await api('/notifications/read-all', { method: 'POST' }); await refreshBell(); } catch (e) { toast(e.message, 'error'); } };
    wrap.querySelector('#bellList').addEventListener('click', async e => {
      const item = e.target.closest('[data-note]');
      if (!item) return;
      e.preventDefault();
      try { await api(`/notifications/${item.dataset.note}/read`, { method: 'POST' }); } catch { /* still navigate */ }
      if (item.dataset.link) location.href = item.dataset.link; else refreshBell();
    });
    document.addEventListener('click', e => { if (!wrap.contains(e.target)) closeBell(); });
    return wrap;
  }
  function renderBell() {
    const wrap = bellEl(); if (!wrap) return;
    const { notifications, unread } = bellData;
    const count = wrap.querySelector('#bellCount');
    count.textContent = unread > 9 ? '9+' : String(unread);
    count.classList.toggle('hidden', !unread);
    wrap.querySelector('#bellBtn').setAttribute('aria-label', unread ? `Notifications, ${unread} unread` : 'Notifications');
    wrap.querySelector('#bellList').innerHTML = notifications.length ? notifications.map(n => `<a href="${esc(n.link || '#')}" class="bell-item${n.read ? '' : ' unread'}" data-note="${n.id}" data-link="${esc(n.link || '')}">
        <span class="bell-icon" aria-hidden="true">${ICONS[n.type] || '🔔'}</span><span class="bell-text"><strong>${esc(n.title)}</strong>${n.body ? `<small>${esc(n.body)}</small>` : ''}<em>${ago(n.created_at)}</em></span></a>`).join('')
      : '<p class="muted bell-empty">No notifications yet. Book an event or join a community and updates will appear here.</p>';
  }
  function openBell() { const w = bellEl(); w.querySelector('#bellPanel').classList.remove('hidden'); w.querySelector('#bellBtn').setAttribute('aria-expanded', 'true'); refreshBell(); }
  function closeBell() { const w = document.getElementById('ccBell'); if (!w) return; w.querySelector('#bellPanel').classList.add('hidden'); w.querySelector('#bellBtn').setAttribute('aria-expanded', 'false'); }
  async function refreshBell() {
    const wrap = bellEl(); if (!wrap) return;
    if (!CC.token) { wrap.classList.add('hidden'); return; }
    try {
      bellData = await api('/notifications');
      wrap.classList.remove('hidden');
      renderBell();
    } catch (e) { if (e.status === 401) wrap.classList.add('hidden'); }
  }
  function startBell() {
    clearInterval(bellTimer);
    refreshBell();
    bellTimer = setInterval(() => { if (!document.hidden) refreshBell(); }, 30000);
  }
  window.addEventListener('cc:session', startBell);
  window.addEventListener('cc:session-expired', () => document.getElementById('ccBell')?.classList.add('hidden'));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startBell); else startBell();

  // ---------- Continue with Google (Google Identity Services) ----------
  // Shown only when the server has GOOGLE_CLIENT_ID set. Google gives us a signed ID token; the server verifies it.
  let gConfig = null, gScript = null, gHandler = null, gInitialised = false;
  const authConfig = () => gConfig || (gConfig = api('/auth/config').catch(() => ({})));
  const loadGsi = () => gScript || (gScript = new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve();
    const sc = document.createElement('script');
    sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true; sc.defer = true;
    sc.onload = () => resolve(); sc.onerror = () => reject(new Error('Google sign-in could not load.'));
    document.head.appendChild(sc);
  }));
  /**
   * Renders a "Continue with Google" button into `el`.
   * getRole() → 'participant' | 'organizer' for brand-new accounts; onAuthed(data) runs after login; onError(message).
   */
  async function mountGoogle(el, { getRole = () => 'participant', onAuthed, onError } = {}) {
    if (!el) return false;
    const cfg = await authConfig();
    if (!cfg.google_client_id) { el.classList.add('hidden'); el.closest('[data-google-block]')?.classList.add('hidden'); return false; }
    try { await loadGsi(); } catch (e) { el.classList.add('hidden'); el.closest('[data-google-block]')?.classList.add('hidden'); return false; }
    const handler = async resp => {
      try {
        const data = await api('/auth/google', { method: 'POST', body: { credential: resp.credential, role: getRole() } });
        CC.setSession(data.token, data.user);
        await onAuthed?.(data);
      } catch (err) { onError ? onError(err.message) : toast(err.message, 'error'); }
    };
    gHandler = handler;
    if (!gInitialised) {
      google.accounts.id.initialize({ client_id: cfg.google_client_id, callback: r => gHandler && gHandler(r), ux_mode: 'popup', auto_select: false, cancel_on_tap_outside: true });
      gInitialised = true;
    }
    el.addEventListener('pointerdown', () => { gHandler = handler; }, { capture: true });
    el.innerHTML = '';
    el.classList.remove('hidden');
    el.closest('[data-google-block]')?.classList.remove('hidden');
    google.accounts.id.renderButton(el, { theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', width: Math.min(360, Math.max(220, el.clientWidth || 320)) });
    return true;
  }

  Object.assign(CC, { mountGoogle, authConfig, badges, shareBar, copyText, referral, qrSvg, checkinUrl, ticketCard, openTicket, closeTicket, ticketFromEvent, downloadQr, refreshBell });
})();

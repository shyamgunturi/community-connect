/* Platform admin dashboard: admin.html — people, activity, money (commission) and organizer payouts. */
(function () {
  'use strict';
  const { api, esc, money, plural, formatDate, toast, setMessage } = CC;
  const $ = id => document.getElementById(id);
  let data = null, filter = 'all';

  const monthName = k => new Date(`${k}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'short' });
  const monthLong = k => new Date(`${k}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const moneyTick = p => p >= 100000 ? `£${+(p / 100000).toFixed(1)}k` : `£${Math.round(p / 100)}`;
  const when = sql => sql ? new Date(`${String(sql).replace(' ', 'T')}Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const kpi = (label, value, sub, cls = '') => `<div class="kpi ${cls}"><small>${label}</small><b>${value}</b><span>${sub}</span></div>`;
  const STATUS = { pending: ['Pending', 'st-pending', 'Event not held yet — money is held'], ready: ['Ready to pay', 'st-ready', 'Event finished — pay the organizer'], paid: ['Paid', 'st-paid', 'Sent to the organizer'] };

  function render() {
    const d = data, s = d.summary, fee = d.fee_percent;
    $('adminSub').textContent = `Platform fee ${fee}% of every paid ticket · ${d.payment_mode === 'stripe' ? 'Stripe payments' : 'demo payments (no real money)'} · updated ${new Date(d.generated_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
    const ex = 1000, exFee = Math.round(ex * fee / 100);
    $('adminContent').innerHTML = `
      <div class="money-flow" aria-label="How the money flows">
        <div><b>1</b><span><strong>Customer pays ${money(ex)}</strong><small>to Community Connect at checkout</small></span></div>
        <i aria-hidden="true">→</i>
        <div><b>2</b><span><strong>We hold it until the event</strong><small>cancelled? everyone is refunded</small></span></div>
        <i aria-hidden="true">→</i>
        <div><b>3</b><span><strong>We keep ${fee}% = ${money(exFee)}</strong><small>platform fee (our revenue)</small></span></div>
        <i aria-hidden="true">→</i>
        <div><b>4</b><span><strong>Organizer gets ${money(ex - exFee)}</strong><small>paid out after the event</small></span></div>
      </div>

      <h2 class="admin-h">Money</h2>
      <div class="kpi-row">
        ${kpi('Platform revenue', money(s.platform_revenue_pence), `our ${fee}% fee on ${plural(s.paid_tickets, 'paid ticket')}`, 'kpi-hero')}
        ${kpi('Ticket sales (gross)', money(s.gross_pence), 'everything customers paid')}
        ${kpi('Ready to pay organizers', money(s.payouts_ready_pence), `${plural(d.payout_totals.ready.count, 'finished event')}`)}
        ${kpi('Held for upcoming events', money(s.payouts_pending_pence), 'paid out after each event')}
        ${kpi('Paid out to organizers', money(s.payouts_paid_pence), `${plural(d.payout_totals.paid.count, 'payout')}`)}
        ${kpi('Refunded', money(s.refunded_pence), `${plural(s.refunded_tickets, 'ticket')} from cancelled events`)}
      </div>
      <h2 class="admin-h">People &amp; activity</h2>
      <div class="kpi-row">
        ${kpi('Participants', s.participants, `+${d.monthly[d.monthly.length - 1].new_participants} this month`)}
        ${kpi('Organizers', s.organizers, `+${d.monthly[d.monthly.length - 1].new_organizers} this month`)}
        ${kpi('Communities', s.communities, 'published')}
        ${kpi('Events', s.events, `${s.events_upcoming} upcoming${s.events_cancelled ? ` · ${s.events_cancelled} cancelled` : ''}`)}
        ${kpi('Tickets', s.paid_tickets + s.free_tickets, `${s.paid_tickets} paid · ${s.free_tickets} free`)}
        ${kpi('Attendance rate', s.attendance_rate == null ? '–' : s.attendance_rate + '%', 'of people who booked, came')}
      </div>

      <div class="viz-grid">
        <section class="viz-card"><header><h4>Ticket money by month — our fee vs organizers' share</h4><p>Each month's paid ticket sales, split into the platform fee and what organizers receive.</p></header><div id="chartSplit"></div></section>
        <section class="viz-card"><header><h4>Platform growth</h4><p>Total participant and organizer accounts.</p></header><div id="chartUsers"></div></section>
      </div>
      <div class="viz-grid">
        <section class="viz-card"><header><h4>Top organizers by ticket sales</h4><p>Gross sales, with the fee we earned from each.</p></header><div id="chartOrganizers"></div></section>
        <section class="viz-card"><header><h4>Biggest communities</h4><p>By members.</p></header><div id="chartCommunities"></div></section>
      </div>

      <section class="viz-card viz-wide" id="payoutsCard"><header class="table-head"><div><h4>Organizer payouts</h4><p>After an event, its takings minus the platform fee are owed to the organizer. Pay them, then mark the payout as paid.</p></div>
        <div class="promo-tabs" role="tablist" aria-label="Filter payouts">${['all', 'ready', 'pending', 'paid'].map(f => `<button type="button" class="promo-tab${filter === f ? ' active' : ''}" data-filter="${f}">${f === 'all' ? 'All' : STATUS[f][0]} <span class="tab-count">${f === 'all' ? d.payouts.length : d.payout_totals[f].count}</span></button>`).join('')}</div></header>
        <div class="table-wrap"><table class="data-table payouts-table"><thead><tr><th>Event</th><th>Organizer</th><th class="num">Tickets</th><th class="num">Gross</th><th class="num">Fee (${fee}%)</th><th class="num">To organizer</th><th>Status</th><th></th></tr></thead>
        <tbody id="payoutRows"></tbody></table></div></section>

      <div class="viz-grid">
        <section class="viz-card"><header><h4>Organizers</h4><p>Sales, our fee and what has been paid out.</p></header>
          <div class="table-wrap"><table class="data-table"><thead><tr><th>Organizer</th><th class="num">Events</th><th class="num">Tickets</th><th class="num">Gross</th><th class="num">Our fee</th><th class="num">Paid out</th></tr></thead>
          <tbody>${d.top_organizers.map(o => `<tr><td><strong>${esc(o.name)}</strong><br><small class="muted">${esc(o.email)}</small></td><td class="num">${o.events}</td><td class="num">${o.tickets}</td><td class="num">${money(o.gross_pence)}</td><td class="num">${money(o.fee_pence)}</td><td class="num">${money(o.paid_out_pence)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No organizers yet.</td></tr>'}</tbody></table></div></section>
        <section class="viz-card"><header><h4>Newest sign-ups</h4><p>The latest accounts on the platform.</p></header>
          <div class="table-wrap"><table class="data-table"><thead><tr><th>Name</th><th>Type</th><th>Joined</th></tr></thead>
          <tbody>${d.recent_users.map(u => `<tr><td><strong>${esc(u.name)}</strong><br><small class="muted">${esc(u.email)}</small></td><td><span class="role-pill role-${esc(u.role)}">${esc(u.role)}</span></td><td>${esc(when(u.created_at))}</td></tr>`).join('')}</tbody></table></div></section>
      </div>`;
    renderPayouts();
    drawCharts();
  }

  function renderPayouts() {
    const rows = data.payouts.filter(p => filter === 'all' || p.status === filter);
    $('payoutRows').innerHTML = rows.map(p => {
      const [label, cls, hint] = STATUS[p.status];
      return `<tr class="payout-${p.status}"><td><a href="event.html?id=${p.event_id}">${esc(p.event_name)}</a><br><small class="muted">${esc(p.community_name)} · ${esc(formatDate(p.event_date, { short: true }))}</small></td>
        <td>${esc(p.organizer_name)}</td><td class="num">${p.tickets}</td><td class="num">${money(p.gross_pence)}</td><td class="num fee-cell">${money(p.fee_pence)}</td><td class="num"><strong>${money(p.net_pence)}</strong></td>
        <td><span class="status-pill ${cls}" title="${esc(hint)}">${label}</span>${p.status === 'paid' ? `<br><small class="muted">${esc(when(p.paid_at))} · ${esc(p.reference || '')}</small>` : ''}</td>
        <td>${p.status === 'ready' ? `<form class="pay-form" data-pay="${p.id}"><input name="reference" maxlength="60" placeholder="Bank ref (optional)" aria-label="Payment reference"><button class="primary-btn" type="submit">Mark as paid</button></form>` : ''}</td></tr>`;
    }).join('') || `<tr><td colspan="8" class="muted">No ${filter === 'all' ? '' : STATUS[filter][0].toLowerCase() + ' '}payouts.</td></tr>`;
  }

  function drawCharts() {
    const d = data, m = d.monthly, cats = m.map(x => monthName(x.month));
    CCCharts.bars($('chartSplit'), {
      categories: cats,
      series: [{ name: 'Platform fee (ours)', color: '--series-1', values: m.map(x => x.fee_pence) }, { name: 'Organizers’ share', color: '--series-2', values: m.map(x => x.gross_pence - x.fee_pence) }],
      format: moneyTick, ariaLabel: 'Platform fee and organizer share by month',
      tooltipTitle: i => monthLong(m[i].month), tooltipExtra: i => `<div class="tip-sub">${plural(m[i].tickets, 'paid ticket')} · ${money(m[i].gross_pence)} gross</div>`
    });
    CCCharts.line($('chartUsers'), {
      categories: cats,
      series: [{ name: 'Participants', color: '--series-1', values: m.map(x => x.total_participants) }, { name: 'Organizers', color: '--series-2', values: m.map(x => x.total_organizers) }],
      format: v => String(Math.round(v)), ariaLabel: 'Accounts over time',
      tooltipTitle: i => `${monthLong(m[i].month)} · +${m[i].new_participants} participants, +${m[i].new_organizers} organizers`
    });
    const org = d.top_organizers.filter(o => o.gross_pence > 0).slice(0, 6);
    if (org.length) CCCharts.hbars($('chartOrganizers'), {
      labels: org.map(o => o.name), values: org.map(o => o.gross_pence), format: p => money(p),
      sub: i => `${money(org[i].fee_pence)} fee`, tooltip: i => `${money(org[i].gross_pence)} sales · ${money(org[i].fee_pence)} platform fee · ${org[i].tickets} tickets`, ariaLabel: 'Top organizers by ticket sales'
    }); else $('chartOrganizers').innerHTML = '<p class="muted viz-empty">No paid ticket sales yet.</p>';
    const com = d.top_communities.slice(0, 6);
    if (com.length) CCCharts.hbars($('chartCommunities'), {
      labels: com.map(c => c.name), values: com.map(c => c.members), format: v => String(v), color: '--series-2',
      sub: i => `${com[i].town} · ${money(com[i].gross_pence)}`, tooltip: i => `${plural(com[i].members, 'member')} · ${plural(com[i].events, 'event')} · organizer ${com[i].organizer_name}`, ariaLabel: 'Biggest communities by members'
    }); else $('chartCommunities').innerHTML = '<p class="muted viz-empty">No communities yet.</p>';
  }

  async function load() {
    try {
      data = await api(`/admin/overview?months=${$('adminMonths').value}`);
      render();
    } catch (err) {
      if (err.status === 401 || err.status === 403) return showLogin(err.status === 403 ? 'This account is not the platform admin.' : '');
      $('adminContent').innerHTML = `<div class="empty-inline error-inline"><strong>The dashboard could not be loaded</strong><p>${esc(err.message)}</p></div>`;
    }
  }

  function showLogin(message) {
    $('adminApp').classList.add('hidden');
    $('adminLogin').classList.remove('hidden');
    setMessage($('adLoginMsg'), message || '', message ? 'error' : 'info');
    $('adEmail').focus();
  }
  async function start() {
    try { await CC.loadUser(); } catch { /* offline */ }
    Detail.renderAccount(start);
    if (!CC.user || CC.user.role !== 'admin') return showLogin(CC.user ? `You are logged in as ${CC.user.role === 'organizer' ? 'an organizer' : 'a participant'}. Log in with the admin account.` : '');
    $('adminLogin').classList.add('hidden');
    $('adminApp').classList.remove('hidden');
    await load();
  }

  $('adminLoginForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('adLoginBtn').disabled = true;
    setMessage($('adLoginMsg'), 'Signing in…');
    try {
      const d = await api('/auth/login', { method: 'POST', body: { email: $('adEmail').value.trim(), password: $('adPassword').value } });
      if (d.user.role !== 'admin') { setMessage($('adLoginMsg'), 'That is not the admin account.', 'error'); return; }
      CC.setSession(d.token, d.user);
      $('adminLoginForm').reset();
      await start();
    } catch (err) { setMessage($('adLoginMsg'), err.message, 'error'); }
    finally { $('adLoginBtn').disabled = false; }
  });
  $('adminMonths').onchange = load;
  $('adminContent').addEventListener('click', e => {
    const f = e.target.closest('[data-filter]');
    if (!f) return;
    filter = f.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
    renderPayouts();
  });
  $('adminContent').addEventListener('submit', async e => {
    const form = e.target.closest('[data-pay]');
    if (!form) return;
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const d = await api(`/admin/payouts/${form.dataset.pay}/pay`, { method: 'POST', body: { reference: form.reference.value.trim() } });
      toast(d.message, 'success');
      await load();
    } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
  });
  window.addEventListener('resize', CC.debounce(() => { if (data) drawCharts(); }, 250));
  start();
})();

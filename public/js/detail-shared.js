/* Shared behaviour for the community and event detail pages: header account area and inline sign-in form. */
(function () {
  'use strict';
  const { api, esc, setMessage, toast } = CC;
  const $ = id => document.getElementById(id);

  function renderAccount(onChange) {
    const slot = $('detailAccount');
    const u = CC.user;
    if (u) {
      slot.innerHTML = `<span class="account-label">Hi, ${esc(u.name.split(' ')[0])} <small class="role-badge">${esc(u.role)}</small></span><a class="outline-btn" href="index.html#dashboard">My dashboard</a><button class="outline-btn" type="button" id="detailLogout">Log out</button>`;
      $('detailLogout').onclick = () => { CC.clearSession(); toast('You have logged out.'); renderAccount(onChange); onChange?.(); };
    } else {
      slot.innerHTML = '<button class="outline-btn" type="button" id="detailLogin">Log in</button>';
      $('detailLogin').onclick = () => Detail.auth?.show('login');
    }
  }

  /**
   * Inline participant sign-in / registration form.
   * onAuthed(user) runs after a successful login or registration.
   */
  function authForm({ section, labels, intro, onAuthed }) {
    let mode = 'login';
    const sec = $(section);
    function show(m = mode, message) {
      mode = m;
      const reg = mode === 'register';
      sec.classList.remove('hidden');
      $('authHeading').textContent = reg ? 'Create your participant account' : 'Log in to continue';
      setMessage($('authMessage'), message || intro);
      $('authNameLabel').classList.toggle('hidden', !reg);
      $('authHint').classList.toggle('hidden', !reg);
      $('authPassword').autocomplete = reg ? 'new-password' : 'current-password';
      $('authSubmit').textContent = reg ? labels.register : labels.login;
      $('authToggle').textContent = reg ? 'I already have an account' : 'Create an account';
      if (!sec.contains(document.activeElement)) (reg ? $('authName') : $('authEmail')).focus({ preventScroll: true });
      sec.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    function hide() { sec.classList.add('hidden'); }
    $('authToggle').onclick = () => show(mode === 'login' ? 'register' : 'login');
    $('detailAuthForm').addEventListener('submit', async e => {
      e.preventDefault();
      const body = { email: $('authEmail').value.trim(), password: $('authPassword').value, role: 'participant' };
      if (!body.email || !body.password) return setMessage($('authMessage'), 'Enter your email address and password.', 'error');
      if (mode === 'register') {
        body.name = $('authName').value.trim();
        if (!body.name) return setMessage($('authMessage'), 'Enter your full name.', 'error');
      }
      $('authSubmit').disabled = true;
      setMessage($('authMessage'), mode === 'register' ? 'Creating your account…' : 'Signing in…');
      try {
        const d = await api('/auth/' + mode, { method: 'POST', body });
        CC.setSession(d.token, d.user);
        $('detailAuthForm').reset();
        hide();
        toast(mode === 'register' ? `Welcome, ${d.user.name.split(' ')[0]}! Your account is ready.` : `Welcome back, ${d.user.name.split(' ')[0]}.`, 'success');
        await onAuthed(d.user);
      } catch (err) {
        setMessage($('authMessage'), err.message, 'error');
      } finally { $('authSubmit').disabled = false; }
    });
    return { show, hide };
  }

  function notFound(container, title, text) {
    $(container).innerHTML = `<div class="detail-body"><p class="eyebrow">NOT FOUND</p><h1>${esc(title)}</h1><p class="detail-description">${esc(text)}</p><a class="primary-btn" href="index.html#discover">Explore communities</a></div>`;
  }

  window.Detail = { renderAccount, authForm, notFound, auth: null };
})();

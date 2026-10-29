(() => {
  // Mobile navigation
  const toggle = document.querySelector('[data-menu-toggle]');
  const nav = document.querySelector('[data-nav]');
  if (toggle && nav) {
    const close = () => { nav.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); };
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', event => { if (!nav.contains(event.target) && !toggle.contains(event.target)) close(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && nav.classList.contains('open')) { close(); toggle.focus(); } });
  }
  document.querySelectorAll('[data-flash-close]').forEach(button => button.addEventListener('click', () => button.closest('.flash')?.remove()));

  // Accessible confirmation dialog for destructive actions (vanilla port of Paradigmshift ConfirmDialog):
  // role="alertdialog", focus starts on "cancel", Escape and backdrop click cancel, focus returns to the trigger.
  let dialog;
  function buildDialog() {
    dialog = document.createElement('div');
    dialog.className = 'dialog-backdrop';
    dialog.hidden = true;
    dialog.innerHTML = '<div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message">'
      + '<h2 id="confirm-title">تأیید عملیات</h2><p id="confirm-message"></p>'
      + '<div class="dialog-actions"><button type="button" class="button button-outline" data-dialog-cancel>انصراف</button>'
      + '<button type="button" class="button button-danger" data-dialog-ok>تأیید</button></div></div>';
    document.body.appendChild(dialog);
    return dialog;
  }
  function confirmAction(message, okLabel) {
    return new Promise(resolve => {
      const d = dialog || buildDialog();
      const previous = document.activeElement;
      const ok = d.querySelector('[data-dialog-ok]');
      const cancel = d.querySelector('[data-dialog-cancel]');
      d.querySelector('#confirm-message').textContent = message;
      ok.textContent = okLabel || 'تأیید';
      d.hidden = false;
      document.body.classList.add('dialog-open');
      cancel.focus();
      const finish = result => {
        d.hidden = true;
        document.body.classList.remove('dialog-open');
        d.removeEventListener('keydown', onKey);
        d.removeEventListener('click', onBackdrop);
        ok.onclick = null; cancel.onclick = null;
        if (previous && previous.focus) previous.focus();
        resolve(result);
      };
      const onKey = event => {
        if (event.key === 'Escape') { event.preventDefault(); finish(false); }
        if (event.key === 'Tab') { // keep focus inside the dialog
          const items = [cancel, ok];
          const index = items.indexOf(document.activeElement);
          event.preventDefault();
          items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length].focus();
        }
      };
      const onBackdrop = event => { if (event.target === d) finish(false); };
      d.addEventListener('keydown', onKey);
      d.addEventListener('click', onBackdrop);
      ok.onclick = () => finish(true);
      cancel.onclick = () => finish(false);
    });
  }
  document.addEventListener('click', async event => {
    const trigger = event.target.closest('[data-confirm]');
    if (!trigger || trigger.dataset.confirmed === 'yes') return;
    event.preventDefault();
    const accepted = await confirmAction(trigger.getAttribute('data-confirm') || 'آیا مطمئن هستید؟', trigger.getAttribute('data-confirm-label'));
    if (!accepted) return;
    const form = trigger.closest('form');
    if (form) {
      trigger.dataset.confirmed = 'yes';
      if (form.requestSubmit) form.requestSubmit(trigger.type === 'submit' ? trigger : undefined); else form.submit();
      setTimeout(() => { delete trigger.dataset.confirmed; }, 0);
    } else if (trigger.href) window.location.href = trigger.href;
  });

  // Prevent double submission and show progress on the clicked button.
  document.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || form.method.toLowerCase() !== 'post') return;
    if (form.dataset.submitting === 'yes') { event.preventDefault(); return; }
    form.dataset.submitting = 'yes';
    form.dataset.dirty = 'no';
    const button = event.submitter || form.querySelector('[type="submit"]');
    if (button) {
      button.setAttribute('aria-busy', 'true');
      if (button.dataset.busyLabel) { button.dataset.originalLabel = button.textContent; button.textContent = button.dataset.busyLabel; }
      setTimeout(() => { button.disabled = true; }, 0);
    }
  });
  window.addEventListener('pageshow', () => {
    document.querySelectorAll('form[data-submitting="yes"]').forEach(form => {
      delete form.dataset.submitting;
      form.querySelectorAll('[aria-busy="true"]').forEach(b => { b.disabled = false; b.removeAttribute('aria-busy'); if (b.dataset.originalLabel) b.textContent = b.dataset.originalLabel; });
    });
  });

  // Warn before leaving an edited admin form (from Paradigmshift useUnsavedGuard).
  const guarded = document.querySelectorAll('form[data-unsaved-guard]');
  guarded.forEach(form => form.addEventListener('input', () => { form.dataset.dirty = 'yes'; }));
  if (guarded.length) {
    window.addEventListener('beforeunload', event => {
      if ([...guarded].some(form => form.dataset.dirty === 'yes')) { event.preventDefault(); event.returnValue = ''; }
    });
  }

  // Password visibility toggle and Caps Lock hint.
  document.querySelectorAll('[data-password-toggle]').forEach(button => {
    const input = document.getElementById(button.getAttribute('data-password-toggle'));
    if (!input) return;
    button.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      button.setAttribute('aria-pressed', String(show));
      button.textContent = show ? 'پنهان' : 'نمایش';
      input.focus();
    });
  });
  const caps = document.querySelector('[data-caps-warning]');
  if (caps) {
    document.addEventListener('keyup', event => { if (event.getModifierState) caps.hidden = !event.getModifierState('CapsLock'); });
  }
})();
// Keep the active item of the horizontally scrolling phone admin menu in view.
if (window.matchMedia('(max-width: 800px)').matches) {
  const active = document.querySelector('.admin-nav-links .admin-link.is-active');
  const strip = active && active.parentElement;
  // Scroll only the strip itself (scrollIntoView could also move the page and the focus origin).
  if (strip) strip.scrollLeft += active.getBoundingClientRect().left - strip.getBoundingClientRect().left - (strip.clientWidth - active.clientWidth) / 2;
}

// Register the service worker so the installed app (TWA/PWA) has an offline shell.
// Guarded: only runs over HTTPS (or localhost) where service workers are allowed anyway.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* non-fatal: site still works without it */ });
  });
}

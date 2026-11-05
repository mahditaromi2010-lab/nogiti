/* Scroll-reveal, staggered card reveals, count-up stats and the signature "flow-divider" line-draw, for the
   item 2 UI/UX pass. Vanilla IntersectionObserver only (no animation library). Fully respects
   prefers-reduced-motion: reduce — in that case everything renders in its final state immediately. */
(() => {
  // Mark the current section in the main nav (styled as an underline in elevate.css).
  const here = location.pathname.replace(/\/$/, '') || '/';
  document.querySelectorAll('.main-nav a[href]').forEach(a => {
    const href = a.getAttribute('href');
    if (href !== '/' && (here === href || here.startsWith(href + '/'))) a.setAttribute('aria-current', 'page');
  });

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reduceMotion) {
    document.querySelectorAll('.reveal-on-scroll, .reveal-item, .flow-divider-svg').forEach(el => el.classList.add('is-visible'));
    document.querySelectorAll('[data-count]').forEach(el => { el.textContent = el.dataset.count || el.textContent; });
    return;
  }

  if (!('IntersectionObserver' in window)) {
    document.querySelectorAll('.reveal-on-scroll, .reveal-item, .flow-divider-svg').forEach(el => el.classList.add('is-visible'));
    return;
  }

  // Hero gas-installation drawing (public/css/elevate.css): its gas-flow / flame loop is pure CSS; pause it
  // while it is off-screen so it costs nothing when nobody is looking at it.
  document.querySelectorAll('.hero-visual').forEach(visual => {
    new IntersectionObserver(([entry]) => visual.classList.toggle('is-paused', !entry.isIntersecting)).observe(visual);
  });

  // Simple sections / cards: fade + rise in, once, on first intersection.
  const revealTargets = document.querySelectorAll('.reveal-on-scroll, .flow-divider-svg');
  const revealObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      revealObserver.unobserve(entry.target);
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
  revealTargets.forEach(el => revealObserver.observe(el));

  // Staggered groups: each .reveal-item inside a .reveal-stagger gets an increasing transition-delay
  // (via --i) so a grid of cards comes in one after another instead of all at once.
  document.querySelectorAll('.reveal-stagger').forEach(group => {
    const items = group.querySelectorAll('.reveal-item');
    items.forEach((item, i) => { item.style.setProperty('--i', String(i % 12)); });
  });
  const staggerObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      staggerObserver.unobserve(entry.target);
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -30px 0px' });
  document.querySelectorAll('.reveal-stagger .reveal-item').forEach(el => staggerObserver.observe(el));

  // Count-up stat numbers (easeOutCubic), triggered once per element when it scrolls into view.
  function animateCount(el, target) {
    const value = Number(target);
    if (!Number.isFinite(value)) { el.textContent = target; return; }
    const duration = 900;
    const start = performance.now();
    const startValue = 0;
    function tick(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = Math.round(startValue + (value - startValue) * eased).toLocaleString('fa-IR');
      if (t < 1) requestAnimationFrame(tick);
      else el.textContent = value.toLocaleString('fa-IR');
    }
    requestAnimationFrame(tick);
  }
  window.__novingityAnimateCount = animateCount; // exposed so public/js/map.js reuses the same easing

  const countObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      const target = el.dataset.count || el.textContent;
      if (!el.dataset.counted) { el.dataset.counted = 'yes'; animateCount(el, target); }
      countObserver.unobserve(el);
    });
  }, { threshold: 0.4 });
  document.querySelectorAll('[data-count]').forEach(el => countObserver.observe(el));

  // Accordion-style smooth collapse/expand for any <details> on the site (ticket/consultation admin rows
  // etc.): animate max-height instead of the abrupt native toggle, while keeping <details> semantics/a11y.
  document.querySelectorAll('details').forEach(details => {
    const summary = details.querySelector('summary');
    const body = details.querySelector(':scope > :not(summary)');
    if (!summary || !body) return;
    summary.addEventListener('click', event => {
      event.preventDefault();
      if (details.open) {
        body.style.maxHeight = body.scrollHeight + 'px';
        requestAnimationFrame(() => { body.style.maxHeight = '0px'; });
        body.addEventListener('transitionend', function onEnd() { details.open = false; body.removeEventListener('transitionend', onEnd); }, { once: true });
      } else {
        details.open = true;
        body.style.maxHeight = '0px';
        requestAnimationFrame(() => { body.style.maxHeight = body.scrollHeight + 'px'; });
        body.addEventListener('transitionend', function onEnd() { body.style.maxHeight = ''; body.removeEventListener('transitionend', onEnd); }, { once: true });
      }
    });
  });
})();

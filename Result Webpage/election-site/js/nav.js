/**
 * nav.js — shared top-level site nav, used by every page.
 *
 * Deliberately minimal placeholder: Phase 2 pages should call renderNav()
 * so every page has consistent top-level links from the start, but Phase 3
 * (Integration & QA) owns finalizing deep-link correctness (e.g. anchors
 * into specific seat-type sections) — don't block on that here.
 */

const LINKS = [
  { href: 'index.html', label: 'General Election' },
  { href: 'referendum.html', label: 'Referendum' },
];

/**
 * Renders the shared nav bar into `container`.
 * @param {HTMLElement} container
 * @param {string} currentHref - filename of the current page (e.g. 'index.html'), used for aria-current
 */
export function renderNav(container, currentHref) {
  const nav = document.createElement('nav');
  nav.className = 'site-nav';

  const brand = document.createElement('span');
  brand.className = 'site-nav__brand';
  brand.textContent = 'Election Results';
  nav.appendChild(brand);

  for (const link of LINKS) {
    const a = document.createElement('a');
    a.href = link.href;
    a.textContent = link.label;
    if (link.href === currentHref) a.setAttribute('aria-current', 'page');
    nav.appendChild(a);
  }

  container.appendChild(nav);
  renderBackToTop();
}

/**
 * Creates the floating "back to top" button (once) and wires up its
 * scroll-triggered visibility and click-to-scroll behavior.
 */
function renderBackToTop() {
  if (document.querySelector('.back-to-top')) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'back-to-top';
  btn.setAttribute('aria-label', 'Back to top');
  btn.textContent = '↑';
  btn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  document.body.appendChild(btn);

  const toggleVisibility = () => {
    btn.classList.toggle('is-visible', window.scrollY > 400);
  };
  window.addEventListener('scroll', toggleVisibility, { passive: true });
  toggleVisibility();
}

/**
 * Renders a breadcrumb trail, e.g. [{label:'Alma Vale', href:'election-alma-vale.html'}, {label:'The City of Alington'}]
 * (last item has no href — it's the current page).
 * @param {HTMLElement} container
 * @param {{label: string, href?: string}[]} crumbs
 */
export function renderBreadcrumbs(container, crumbs) {
  const el = document.createElement('div');
  el.className = 'site-nav__breadcrumbs';
  el.innerHTML = crumbs
    .map((c, i) => {
      const sep = i > 0 ? ' &raquo; ' : '';
      const text = c.href ? `<a href="${c.href}">${c.label}</a>` : c.label;
      return sep + text;
    })
    .join('');
  container.appendChild(el);
}

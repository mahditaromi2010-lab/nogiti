# QA report — Novingity (novingity.ir), 2026-11-05

- **Site / authorization**: novingity.ir — owned by Mahdi (owner of this repo). Full testing on a local copy; live was not reachable from the cloud workspace (proxy), so no requests were sent to the live site.
- **Code under test**: `main` @ `c531bb9` (same commit as live after the last deploy). Fixes on branch `qa/2026-11-05-fixes`.
- **Target**: local copy, PostgreSQL 16, `NODE_ENV=production` on :3100 for crawl/performance, `development` on :3101 for the OTP flow (code shown on the page; no real SMS). Payment gateway not configured locally, so checkout was tested only up to the "gateway" step — no money involved.
- **Modules used**: first visit, account (phone + OTP), shop/orders (stopped before payment), tool/calculator, forms (support ticket), content (articles), admin panel, quality (axe, Lighthouse, headers, SEO), regression.

## Test runs

| Suite | Before fixes | After fixes |
|---|---|---|
| Syntax lint (JS + EJS) | pass | pass |
| Unit tests | 36 / 36 | 36 / 36 |
| Integration tests (PostgreSQL) | **76 / 94** (18 failing) | **101 / 101** |
| UI suite `npm run test:ui` (3 widths, admin, calculators) | — | **210 / 210** |
| Calculator comparison vs client tables (660 low-pressure + 374 high-pressure combos, 21 meter values, chimney, vent, converter) | 0 mismatches in pipe tables; 7 meter failures; EN results in Persian | 0 mismatches |

## Metrics (Lighthouse mobile, throttled, local copy)

| Page | Perf | A11y | Best pr. | SEO | LCP | CLS | TBT | Weight |
|---|---|---|---|---|---|---|---|---|
| `/` | 96 | 96 | 96 | 100 | 1.9 s | 0 | 230 ms | 181 KB |
| `/tools` | 99 | 96 | 89 | 100 | 2.1 s | 0 | 80 ms | 190 KB |
| `/shop/<plugin>` | 100 | 96 | 96 | 100 | 1.8 s | 0 | 0 ms | 179 KB |
| `/articles/<article>` | 100 | 94 | 96 | 100 | 1.9 s | 0 | 0 ms | 179 KB |

axe-core (18 page/language combinations): **no critical violations**; `color-contrast` (serious) on every page; `heading-order` and `landmark-complementary-is-top-level` (moderate) on a few.

## Issues

| ID | Area | Page / flow | What happened | Expected | Sev | Status |
|---|---|---|---|---|---|---|
| Q1 | Calculator | `/tools` meter | Values between brackets with two decimals (4.05, 6.05, 10.05, 16.05, 25.05, 40.05, 65.05 m³/h) showed "must be between 0.1 and 100" | The next meter class (G4, G6 …) | P1 | **Fixed** — brackets are now contiguous; UI test added |
| Q2 | Calculator / i18n | `/tools` in English | Every calculator result and message was Persian. The page set its language with an inline `<script>` that the site's own CSP blocks (console error on every `/tools` load) | English results | P1 | **Fixed** — language read from `<html data-locale>`; inline scripts removed (also from the hidden map page); UI test added |
| Q3 | Calculator | `/tools` all fields | Typing Persian digits (`۳`, `۲٫۵`) with a Persian keyboard left the field empty → "enter a valid value" | Accepts ۰-۹, ٠-٩, `٫` and `,` | P1 | **Fixed** — text inputs with `inputmode="decimal"` + digit normalisation; UI test added |
| Q4 | Tests | CI | 18 integration tests failed because the hidden coverage map used hard-coded `if (true)` guards — the suite was permanently red | Hidden feature, green suite | P1 | **Fixed** — real switch `FEATURE_COVERAGE_MAP` (off unless set to `true`); tests run with it on and a new test checks it stays hidden when off |
| Q5 | Shop | Product with price 0 | Shows "خرید و دریافت دسترسی"; with the gateway configured, checkout fails ("amount below gateway minimum") and records a failed order | "Free" label and instant access — or not allowed at all | P1 | **Needs your decision** (see below) — not changed |
| Q6 | Account / privacy | Logout → browser Back | The private `/account` page (orders, library) is shown again from the browser cache | Not shown after logout (shared computers) | P2 | **Fixed** — `Cache-Control: no-store` on every signed-in customer response; integration test added |
| Q7 | i18n | English pages | Header/footer tagline and About text were the Persian admin settings (About text even says "Nogiti") | English text | P2 | **Fixed** — new English fields in Admin → Settings (tagline, About text); English defaults when empty; test added |
| Q8 | i18n | English 404 / product / article not found, rate-limit page, checkout messages | Hard-coded Persian | English | P2 | **Fixed** — moved to locale files |
| Q9 | SEO | `/robots.txt`, `/sitemap.xml` | 404 | Present; sitemap lists published products/articles only | P2 | **Fixed** — both added; test added |
| Q10 | SEO | All pages | No `canonical`; English uses the same URLs as Persian (cookie switch), so search engines index one language only and there is no `hreflang` | Separate language URLs (e.g. `/en/...`) with `hreflang` | P2 | Open — bigger change, recommended next |
| Q11 | Resilience | Home, about, every scroll-reveal section | With JavaScript off (or if `motion.js` fails), all reveal-on-scroll content stays invisible (opacity 0) | Content visible | P2 | **Fixed** for JS-off via `<noscript>` style; full fix in the visual overhaul |
| Q12 | Accessibility | Every page | Text contrast below 4.5:1 (e.g. hero outline button 2.19:1, small grey labels 3.96:1); 11 px text on phone | WCAG AA | P2 | Open — part of the visual overhaul |
| Q13 | Account | OTP request | Limit is 3 requests / 10 min **per IP**, and invalid numbers count too. On Iranian mobile networks many users share one IP, so one user's typos can block others | Count per phone + IP, skip invalid formats | P2 | Open — recommended |
| Q14 | Security hygiene | Hidden map page | Admin-entered map data was embedded in a `<script>` block without escaping `<` (a `</script>` in a name could break out) | Escaped | P2 | **Fixed** (`<`) |
| Q15 | UI | Product page | Section numbers jump 01 → 04 when optional sections are empty | Consecutive | P3 | Open |
| Q16 | UI | Header (signed-in, no first name) | Avatar shows "0" (first digit of the phone), which reads like a notification count | An icon or "?" | P3 | Open |
| Q17 | Content | Footer / settings | Contact email `nugasbnd@gmail.com` and Instagram `@nugas_bnd` still use the old brand | Owner's choice | P3 | Info — change in Admin → Settings if wanted |

### Q5 — needs a decision
A product priced 0 currently cannot be obtained. Options: (a) treat 0 as **free**: show "رایگان / Free", button "دریافت رایگان" grants access immediately without the gateway; or (b) block publishing a product with price 0. Tell me which and I'll implement it.

## What works well
- All 660 low-pressure and 374 high-pressure pipe combinations match the client's tables exactly; over-length/over-capacity show clear warnings instead of a wrong size. Chimney and meter (after Q1) correct.
- OTP login: Persian digits accepted, wrong code / resend-within-60 s / 5-attempt limit all give clear Persian messages; session regenerated on login.
- Escaping: `<script>` / `<img onerror>` in product, article and ticket text is shown as text, never executed. Drafts return 404.
- Security headers: strict CSP, HSTS, `nosniff`, `X-Frame-Options`, `Referrer-Policy: no-referrer`; `/.env`, `/.git` 404; admin pages 403 without login; wrong admin password rejected.
- Speed: ~180 KB pages, LCP ≈ 2 s on throttled mobile, CLS 0.
- Admin: all 21 admin pages load with no console errors and no horizontal scroll on phone.

## Honest critique (as a customer)
- **Would make me leave**: the home page sells "tools, courses, plugins" but the shop and articles are empty-state boxes; a first visitor sees a promise without proof. The colours are low-contrast and small on phone. In English, parts of the site were still Persian (fixed now).
- **Would make me trust**: the calculators are correct, fast and cite the regulation tables; clean, consistent design; clear error messages.
- **Looks unfinished**: the "Disclaimer" box is good, but there is no "who is behind this" proof (licence, engineer name, Enamad/eNamad seal, address) anywhere near the shop.

## Not tested, and why
- Live site (novingity.ir): unreachable from the cloud workspace; everything ran on a local copy of the same commit. After deploy, open `/tools` in English and try `4.05` in the meter to confirm.
- Real payment: no gateway credentials locally (and never with real money).
- Real SMS delivery (Kavenegar): no API key locally.
- WebKit / Firefox: only Chromium is installed in this workspace.
- Hidden coverage map: only checked that it stays hidden and its tests pass.

## Test data
Local copy only (databases `nogiti_qa`, `nogiti_test`): QA-TEST products, article, ticket, customer `09120000000`, admin `qa_test_owner`. Nothing was created on the live site.

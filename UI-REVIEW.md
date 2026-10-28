# UI/UX review — 3T Web Marketplace (static audit, 2026-10-27)

Scope: all docs/05 screen groups (public, auth, demo, buyer checkout,
customer account, admin, partner, plus shared states). Method: static
audit of the web app's components and stylesheet against the four target
widths (360 / 390 / 768 / 1440). This is NOT a rendered browser pass:
this session cannot operate a live browser, so no screenshot, tap, or
keyboard walkthrough is claimed here. A browser delegation checklist is
at the end.

## Coverage

- The app has 79 page routes; docs/05 lists 95 screens. The gap is
  in-page states, not missing routes: loading, error, empty, confirm,
  and expired states render inside their route (every page built in
  M4–M7 carries loading/error/empty states), so one route covers
  several screen IDs.
- Breakpoints in the stylesheet: 1023px (sidebar to horizontal nav,
  3-col cards to 2-col) and 639px (cards to 1-col, header nav wraps,
  detail lists stack). Widths 360/390 fall under the 639px rules, 768
  under the 1023px rules, 1440 is the desktop layout. The demo viewer
  additionally offers explicit 100% / 768px / 390px preview widths.

## Findings by group

- Public catalog (P): cards 3 to 2 to 1 column; images keep 16/10 with
  object-fit cover; filter form is a wrapping row of labelled controls
  (search, mode, capability, category, min/max price) with full-width
  inputs. No structural overflow risk. Watch item for the browser pass:
  on 360px the five filter controls stack into a tall block above the
  results; if that feels heavy, the standard pattern is a filter drawer
  (bottom sheet with sticky Apply and Reset) — a future change, not a
  defect today, since there are only five facets.
- Auth (U): centred form container, labels above fields, 44px inputs,
  16px base font inherited by inputs (no mobile zoom trap), visible
  focus outline (3px + offset), skip link to main landmark.
- Demo (D): iframe is sandboxed without allow-same-origin on a separate
  origin, width 100% with max-width presets, height 640; the width
  switcher row wraps. No horizontal overflow path found.
- Buyer checkout (B): the pay page shows the order total in a details
  block directly above the primary action, with a secondary
  check-status action; the issue page lists attempts and refunds with a
  pay-again link when awaiting payment. The order summary is always
  visible because the page has one job; a collapsed-summary pattern
  would only matter if checkout gains more steps.
- Customer account (C): dashboard sidebar becomes a horizontally
  scrollable nav under 1023px with nowrap links; tables (orders,
  purchases, sites, tickets, backups) all sit in scrollable wrappers;
  long tokens and hashes use break-all mono; restore and delete
  actions are gated on typing the site name.
- Admin (A): same dashboard shell; all 34 table-bearing pages use the
  scrollable table wrapper (verified by grep — zero unwrapped tables);
  forms use labelled full-width controls; destructive actions carry a
  reason field (min 3 chars) or a confirm step.
- Partner (R): same shell and table rules; secret values are shown once
  in break-all mono; scope checkboxes and delivery tables follow the
  shared patterns.
- Shared: buttons are 44px minimum height; rows wrap; grids use
  minmax(0, 1fr) so content cannot force overflow; reduced-motion is
  respected; every image carries alt text; forms carry labels.

## Pattern comparison (generic principles, no copied content/brand/code)

Public research on marketplace, SaaS, and checkout layout agrees on the
patterns this app already follows: labels above fields (never
placeholder-only), inline field errors naming the fix, 44px touch
targets, full-width primary actions on mobile, sticky or always-visible
order totals during payment, sidebar-to-scroll-nav on small dashboards,
and filter drawers once facet counts grow past a handful. The app
matches on all of these except the drawer, which it does not need yet
at five facets. Two details worth keeping: checkout error copy already
names the problem and the fix via localized error keys, and the demo
iframe already isolates demo code from portal cookies.

## Changes made in this pass

None to styles or markup. The audit found no structural defect (no
unwrapped table, no fixed-width grid, no sub-44px target, no sub-16px
input font, no missing focus style), and pixel-level polish decided
without rendering would risk regressions. The ranked work below belongs
to the browser pass.

## Browser delegation checklist (for a browser-capable agent)

Run the app, sign in as owner, buyer, and partner, and walk each group
at 360 / 390 / 768 / 1440. For every route, check: (1) no horizontal
overflow; (2) primary action reachable without scrolling past unrelated
content on mobile; (3) filter controls usable at 360px (catalog) and
the five-facet stack acceptable; (4) checkout total visible before the
pay action at 360px; (5) demo iframe usable at 390px preset on a 360px
viewport; (6) dashboard nav scrollable and the active item visible;
(7) long strings (tokens, hashes, URLs, domain names) wrap without
breaking tables; (8) keyboard order follows visual order and focus is
always visible; (9) Vietnamese strings do not overflow buttons or
table cells (Vietnamese runs longer than English); (10) loading,
error, and empty states render at 360px. Report screenshots and any
overflow with route + width + element; do not copy layout, copy, or
branding from reference sites — use them only for pattern ideas.

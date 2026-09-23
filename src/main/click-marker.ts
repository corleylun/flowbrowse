/**
 * The human-visible "the agent is acting HERE" marker: a brief outline over the element (or
 * point) an agent `click`/`fill`/`click_at` targets, so the human can see which button was just
 * pressed instead of inferring it from the page's reaction.
 *
 * main.ts draws it in a separate, transparent overlay `WebContentsView` stacked above the page
 * and below the chrome — deliberately NOT injected into the page DOM:
 * - **Invisible to the agent.** `capturePage` on the tab's webContents never includes another
 *   view, so `screenshot`/`read_screen_text` don't capture it, and there's no DOM node for
 *   `read_page`/`inspect_element`/`run_js` to see.
 * - **Untamperable by the page**, and it **survives navigation** — a click that submits a form
 *   replaces the page at the moment the human most needs to see what was pressed.
 *
 * Purely cosmetic: no audit, no liveness check, no effect on what the tool does or returns.
 * This file holds only the pure geometry + markup so it's testable without Electron.
 */
import type { HighlightMark } from './page-controller';

/** How long the marker stays up (hold + CSS fade), ms. A fixed constant, not action-dependent. */
export const MARKER_HOLD_MS = 1200;
export const MARKER_FADE_MS = 300;
/** Outset around an element's rect so the stroke doesn't sit on the element's own border. */
export const MARKER_OUTSET = 3;
/** Side of the ring drawn for a bare point (`click_at`). */
export const MARKER_RING = 28;

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Window-content bounds for the overlay view, given the tab view's origin in the window. */
export function markerBounds(mark: HighlightMark, pageX: number, pageY: number): Bounds {
  const r =
    mark.kind === 'point'
      ? { x: mark.x - MARKER_RING / 2, y: mark.y - MARKER_RING / 2, w: MARKER_RING, h: MARKER_RING }
      : { x: mark.x - MARKER_OUTSET, y: mark.y - MARKER_OUTSET, w: mark.w + 2 * MARKER_OUTSET, h: mark.h + 2 * MARKER_OUTSET };
  return {
    x: Math.round(pageX + r.x),
    y: Math.round(pageY + r.y),
    width: Math.max(1, Math.round(r.w)),
    height: Math.max(1, Math.round(r.h)),
  };
}

/** The overlay's own page: a box filling the view; `show(ring)` restarts the hold→fade. */
export const MARKER_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden}
#m{box-sizing:border-box;position:absolute;inset:0;border:3px solid #ff9500;background:rgba(255,149,0,.18);border-radius:4px;opacity:0}
#m.ring{border-radius:50%}
#m.on{animation:f ${MARKER_HOLD_MS + MARKER_FADE_MS}ms linear forwards}
@keyframes f{0%,${Math.round((MARKER_HOLD_MS / (MARKER_HOLD_MS + MARKER_FADE_MS)) * 100)}%{opacity:1}100%{opacity:0}}
</style></head><body><div id="m"></div><script>
function show(ring){const m=document.getElementById('m');m.className='';void m.offsetWidth;m.className=ring?'on ring':'on';}
</script></body></html>`;

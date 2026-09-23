import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ElectronPageController, type HighlightMark } from './page-controller';
import { MARKER_OUTSET, MARKER_RING, markerBounds } from './click-marker';

/** Click-marker coverage: the controller reports WHERE it acted (zoom-scaled, element rect or
 *  point) to the highlight hook, and never leaks the rect into the agent-facing result. */

function makeFake(result: unknown, zoom = 1) {
  const wc = {
    isDestroyed: () => false,
    getZoomFactor: () => zoom,
    sendInputEvent: () => {},
    async executeJavaScript(script: string): Promise<unknown> {
      if (script.includes('innerWidth')) return { vw: 1000, vh: 800 };
      return result;
    },
  };
  const marks: HighlightMark[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctrl = new ElectronPageController(() => wc as any, { highlight: (_id, m) => marks.push(m) });
  return { ctrl, marks };
}
const live = { isLive: () => true, signal: new AbortController().signal };

test('click marks the element rect, scaled by zoom, and strips it from the result', async () => {
  const { ctrl, marks } = makeFake({ clicked: true, matched: 'Go', rect: { x: 40, y: 50, w: 120, h: 40 } }, 2);
  const r = await ctrl.click('t', '#go');
  assert.deepEqual(marks, [{ kind: 'rect', x: 80, y: 100, w: 240, h: 80 }]);
  assert.equal('rect' in r, false, 'the marker geometry must not reach the agent');
  assert.equal(r.clicked, true);
});

test('a click that found nothing draws no marker', async () => {
  const { ctrl, marks } = makeFake({ clicked: false, matched: '' });
  await ctrl.click('t', '#nope');
  assert.deepEqual(marks, []);
});

test('fill marks the field and strips the rect', async () => {
  const { ctrl, marks } = makeFake({ filled: true, matched: 'email', rect: { x: 10, y: 20, w: 200, h: 30 } });
  const r = await ctrl.fill('t', '#email', 'a@b.c');
  assert.deepEqual(marks, [{ kind: 'rect', x: 10, y: 20, w: 200, h: 30 }]);
  assert.equal('rect' in r, false);
});

test('clickAt marks a point in device coords', async () => {
  const { ctrl, marks } = makeFake(null, 2);
  await ctrl.clickAt('t', 100, 50, 'left', live);
  assert.deepEqual(marks, [{ kind: 'point', x: 200, y: 100, w: 0, h: 0 }]);
});

test('markerBounds: rect is outset and offset by the page origin; point is a centred ring', () => {
  assert.deepEqual(markerBounds({ kind: 'rect', x: 40, y: 50, w: 120, h: 40 }, 0, 132), {
    x: 40 - MARKER_OUTSET,
    y: 132 + 50 - MARKER_OUTSET,
    width: 120 + 2 * MARKER_OUTSET,
    height: 40 + 2 * MARKER_OUTSET,
  });
  assert.deepEqual(markerBounds({ kind: 'point', x: 100, y: 100, w: 0, h: 0 }, 0, 132), {
    x: 100 - MARKER_RING / 2,
    y: 232 - MARKER_RING / 2,
    width: MARKER_RING,
    height: MARKER_RING,
  });
});

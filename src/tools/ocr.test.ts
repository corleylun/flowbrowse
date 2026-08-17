import test from 'node:test';
import assert from 'node:assert/strict';
import { mapWordsToViewport, pngDimensions, OcrWord } from './ocr';

const w = (text: string, x0: number, y0: number, x1: number, y1: number, confidence = 90): OcrWord => ({
  text,
  x0,
  y0,
  x1,
  y1,
  confidence,
});

test('1:1 raster→viewport: centre + rect computed from the box', () => {
  const out = mapWordsToViewport([w('Submit', 100, 40, 200, 80)], { width: 1000, height: 800 }, { w: 1000, h: 800 });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    text: 'Submit',
    x: 150, // (100+200)/2
    y: 60, // (40+80)/2
    rect: { x: 100, y: 40, width: 100, height: 40 },
    confidence: 90,
  });
});

test('retina 2× raster halves coordinates (the ratio folds out devicePixelRatio/zoom)', () => {
  // A 2000×1600 raster of a 1000×800 CSS viewport → every coordinate scales by 0.5.
  const out = mapWordsToViewport([w('Buy', 400, 200, 600, 280)], { width: 2000, height: 1600 }, { w: 1000, h: 800 });
  assert.deepEqual(out[0], {
    text: 'Buy',
    x: 250, // ((400+600)/2) * 0.5
    y: 120, // ((200+280)/2) * 0.5
    rect: { x: 200, y: 100, width: 100, height: 40 },
    confidence: 90,
  });
});

test('whitespace-only words are dropped, and text is trimmed', () => {
  const out = mapWordsToViewport(
    [w('   ', 0, 0, 10, 10), w('  Hi  ', 20, 20, 40, 40)],
    { width: 100, height: 100 },
    { w: 100, h: 100 },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'Hi');
});

test('results are ordered top-to-bottom, then left-to-right', () => {
  const out = mapWordsToViewport(
    [w('c', 10, 200, 20, 210), w('b', 200, 10, 210, 20), w('a', 10, 10, 20, 20)],
    { width: 500, height: 500 },
    { w: 500, h: 500 },
  );
  assert.deepEqual(out.map((o) => o.text), ['a', 'b', 'c']);
});

test('the cap bounds the number of returned words (but count in the tool is pre-cap)', () => {
  const many: OcrWord[] = Array.from({ length: 10 }, (_, i) => w(`x${i}`, i, i, i + 5, i + 5));
  const out = mapWordsToViewport(many, { width: 100, height: 100 }, { w: 100, h: 100 }, 3);
  assert.equal(out.length, 3);
});

test('a zero-sized raster does not divide-by-zero (Math.max(1, …) guard)', () => {
  const out = mapWordsToViewport([w('x', 0, 0, 2, 2)], { width: 0, height: 0 }, { w: 100, h: 100 });
  assert.equal(out.length, 1);
  assert.ok(Number.isFinite(out[0].x) && Number.isFinite(out[0].y));
});

test('pngDimensions reads the PHYSICAL raster from IHDR (the retina fix)', () => {
  // Minimal PNG header: 8-byte signature, 4-byte length, "IHDR", then width/height big-endian.
  const png = Buffer.alloc(24);
  png.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(2000, 16); // physical width (e.g. a 1000-DIP viewport at 2× retina)
  png.writeUInt32BE(1600, 20); // physical height
  assert.deepEqual(pngDimensions(png), { width: 2000, height: 1600 });
});

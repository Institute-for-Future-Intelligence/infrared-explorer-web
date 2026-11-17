// Tests for annotationPlacement.ts — a note's text is drawn inside the frame whatever its stored
// offset says: pushed in from an edge, moved to the anchor's other side when it has no room on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeAnnotationText, type AnnotationTextPlacement } from './annotationPlacement';

// A 400 × 300 frame, a text 100 wide and 20 tall, standing 2 px above the line's end.
const frame = { width: 400, height: 300 };
const text = { width: 100, height: 20 };
const place = (anchorX: number, end: { x: number; y: number }) => placeAnnotationText(anchorX, end, text, frame, 2);
const inside = (p: AnnotationTextPlacement) => {
  const left = p.toLeft ? p.x - text.width : p.x;
  const top = p.y - 2 - text.height;
  return left >= 0 && left + text.width <= frame.width && top >= 0 && p.y - 2 <= frame.height;
};

test('a text that fits stays where its offset puts it', () => {
  assert.deepEqual(place(300, { x: 250, y: 150 }), { x: 250, y: 150, toLeft: true });
  assert.deepEqual(place(100, { x: 150, y: 150 }), { x: 150, y: 150, toLeft: false });
});

test('a text is pushed in from the edge it would cross', () => {
  assert.deepEqual(place(300, { x: 40, y: 150 }), { x: 100, y: 150, toLeft: true });
  assert.deepEqual(place(100, { x: 380, y: 150 }), { x: 300, y: 150, toLeft: false });
});

test('the text moves to the other side of an anchor that stands by the edge', () => {
  // the default below-left offset, on an anchor 20 px from the left edge
  const a = place(20, { x: -12, y: 190 });
  assert.equal(a.toLeft, false);
  assert.equal(a.x, 20);
  assert.ok(inside(a));
  const b = place(390, { x: 395, y: 190 });
  assert.equal(b.toLeft, true);
  assert.ok(inside(b));
});

test('a text above the top edge comes down, one below the bottom comes up', () => {
  assert.equal(place(300, { x: 250, y: 5 }).y, 22);
  assert.equal(place(300, { x: 250, y: 340 }).y, 300);
});

test('a text wider than the frame shows its beginning', () => {
  assert.deepEqual(placeAnnotationText(200, { x: 150, y: 100 }, { width: 500, height: 20 }, frame, 2), {
    x: 0,
    y: 100,
    toLeft: false,
  });
});

test('every text is inside, wherever the anchor and the offset are, and the answer is stable', () => {
  for (let ax = 0; ax <= 400; ax += 25) {
    for (let ex = -150; ex <= 550; ex += 35) {
      for (const ey of [-40, 0, 12, 150, 299, 360]) {
        const once = place(ax, { x: ex, y: ey });
        assert.ok(inside(once), `anchor ${ax}, end ${ex},${ey}`);
        // what a drag of the text stores is drawn where it was stored
        assert.deepEqual(place(ax, { x: once.x, y: once.y }), once);
      }
    }
  }
});

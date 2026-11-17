// Where a note's text is drawn so that ALL of it is inside the frame.
//
// A note stores where its text stands as an offset from its anchor, in fractions of the frame — and
// nothing in that says the text fits there. Its size is in pixels, so the same offset that sits well on
// a wide player runs off a narrow one (a phone, the app); an anchor dragged to an edge carries its text
// over it; a note added by the left edge was born with its text outside (the default offset is
// below-LEFT). Text outside the frame cannot be grabbed, so the only way back was to move the anchor
// first. This is asked every time a note is drawn, whatever its stored offset says:
//
//  - The text runs AWAY from the anchor — left of the line's end when the end is left of the anchor,
//    right otherwise (the callout's textAnchor end / start).
//  - When the whole text has no room on that side of the anchor and has it on the other, it changes
//    sides, and starts at the anchor.
//  - Then it is pushed in from whichever edge it still crosses, and down from the top (the text stands
//    above the line's end, `lift` px clear of it).
//  - A text wider than the frame shows its beginning.
//
// Nothing stored changes by being drawn: an anchor dragged away from the edge again finds its text back
// where the user had put it. A drag of the TEXT stores what this answers, so what is kept is what was
// seen. The app draws by the same rule (infrared-explorer-app src/lib/annotations.ts
// placeAnnotationText) — keep the two alike.

export interface AnnotationTextPlacement {
  // The end of the note's line, in the frame's pixels: the bottom corner of the text on the anchor's side.
  x: number;
  y: number;
  // The text runs to the LEFT of (x, y); false = to the right.
  toLeft: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * `anchorX` and `end` (where the stored offset puts the line's end) are in the frame's pixels; `text` is
 * the text's own size as the browser laid it out.
 */
export function placeAnnotationText(
  anchorX: number,
  end: { x: number; y: number },
  text: { width: number; height: number },
  frame: { width: number; height: number },
  lift = 0,
): AnnotationTextPlacement {
  const W = Math.max(0, frame.width);
  const H = Math.max(0, frame.height);
  const tw = Math.max(0, text.width);
  const th = Math.max(0, text.height);
  // The text stands in [y − lift − th, y − lift]: keep its top in the frame, and the line's end with it.
  const y = clamp(end.y, Math.min(th + lift, H), H);
  if (tw >= W) {
    return { x: 0, y, toLeft: false };
  }
  const wantsLeft = end.x < anchorX;
  // Room for the whole text on that side of the anchor.
  const leftFits = tw < anchorX;
  const rightFits = anchorX <= W - tw;
  const toLeft = wantsLeft ? leftFits || !rightFits : !rightFits && leftFits;
  if (toLeft) {
    // Changing sides: from just left of the anchor, so the side holds when the answer is stored and
    // asked again.
    return { x: clamp(wantsLeft ? end.x : anchorX - 1, tw, W), y, toLeft: true };
  }
  return { x: clamp(wantsLeft ? anchorX : end.x, 0, W - tw), y, toLeft: false };
}

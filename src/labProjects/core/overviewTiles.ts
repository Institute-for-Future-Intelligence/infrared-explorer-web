/*
 * Which moments a take's overview sheets show, and how they are paged.
 *
 * The moments are spread evenly from the first frame to the last, never
 * closer than a second apart, and their number grows with the square root of
 * the take's length — a take four times as long gets twice the tiles — up to
 * MAX_TILES: a 10 s take gets one a second, 105 s gets 41 (one every 2.6 s),
 * 10 minutes gets 60 (one every 10 s), as does anything longer. A take with
 * fewer frames than that shows every frame.
 *
 * A sheet holds TILES_PER_SHEET tiles, SHEET_COLUMNS across, each 2 × the
 * thermal grid (240 × 320): the sheet is then 752 px wide, under the 768 px
 * short side above which the model providers scale a picture down, so a
 * tile reaches the model at the size it was drawn.
 *
 * Pure; tested in __tests__/labProjectsOverviewTiles.test.ts.
 */

export const SHEET_COLUMNS = 3;
export const TILES_PER_SHEET = 15;
export const MAX_TILES = 60;
/** Tiles per square root of a second of take: 4 × √105 ≈ 41. */
export const TILES_PER_ROOT_SECOND = 4;

/** How many moments a take of `frameCount` frames over `durationSec` seconds shows. */
export function tileCount(frameCount: number, durationSec: number): number {
  if (frameCount <= 1) {
    return Math.max(0, Math.floor(frameCount));
  }
  const seconds = Math.max(0, durationSec);
  // one a second at most: that many intervals from the first frame to the last
  const oneASecond = Math.floor(seconds) + 1;
  const grown = Math.round(TILES_PER_ROOT_SECOND * Math.sqrt(seconds));
  return Math.max(2, Math.min(frameCount, oneASecond, grown, MAX_TILES));
}

/** The frames (1-based) the sheets show: tileCount of them, evenly spaced, the first and the last among them. */
export function tileFrames(frameCount: number, durationSec: number): number[] {
  const count = tileCount(frameCount, durationSec);
  if (count <= 1) {
    return count === 1 ? [1] : [];
  }
  return Array.from({length: count}, (_, k) => 1 + Math.round((k * (frameCount - 1)) / (count - 1)));
}

/** Tiles paged into sheets of TILES_PER_SHEET, in order. */
export function sheetsOf<T>(tiles: readonly T[]): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < tiles.length; i += TILES_PER_SHEET) {
    pages.push(tiles.slice(i, i + TILES_PER_SHEET));
  }
  return pages;
}

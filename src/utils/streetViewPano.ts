/*
 * Street-view panorama math — the pure geometry behind the look-around viewer
 * (streetViewViewer + streetViewCompass). Verbatim port of the app's
 * lib/streetViewPano.ts (itself a port of the legacy VideoStreetView.java): each
 * recorded frame is an azimuth sample of a slow ~360° turn, so "looking around"
 * is scrubbing the frame index (→ a video seek), and the compass / N-E-S-W
 * bearing lines / pitch line are placed from the current frame's azimuth within
 * the thermal camera's field of view.
 *
 * FOV = the FLIR thermal camera constants: hfov 43°, vfov 55°.
 * All angles are DEGREES; azimuth is signed −180..180 (N=0, E=90, W=−90, S=±180).
 */

export const STREET_VIEW_HFOV = 43;
export const STREET_VIEW_VFOV = 55;

/** Compass bearings of the four cardinal directions (azimuth degrees). */
export const CARDINALS: { label: 'NORTH' | 'EAST' | 'SOUTH' | 'WEST'; bearing: number }[] = [
  { label: 'NORTH', bearing: 0 },
  { label: 'EAST', bearing: 90 },
  { label: 'SOUTH', bearing: 180 },
  { label: 'WEST', bearing: -90 },
];

/** Normalize a degree value to the half-open range (−180, 180]. */
export function normalizeDeg(deg: number): number {
  const x = ((((deg + 180) % 360) + 360) % 360) - 180;
  // −180 maps to 180 so SOUTH resolves to a single value.
  return x === -180 ? 180 : x;
}

/** Wrap a 1-indexed frame into [1, frameCount] (seamless 360° look-around). */
export function wrapFrame(frame: number, frameCount: number): number {
  if (frameCount <= 0) return 1;
  return ((((Math.round(frame) - 1) % frameCount) + frameCount) % frameCount) + 1;
}

/**
 * Java seek constant: VideoStreetActivity.moveVideoFrame subtracts 0.5 ×
 * horizontal velocity (px/s) per ~60 Hz MOVE event — i.e. ≈30 ms of video per
 * PHYSICAL pixel dragged. At the recorder's 5 fps (200 ms/frame) a full-width
 * swipe sweeps the whole ~360° clip.
 */
export const SEEK_MS_PER_PX = 30;

/** ms of video per frame at the recorder's fixed 5 fps. */
export const FRAME_MS = 200;

/**
 * Java-parity look-around: map a horizontal drag (PHYSICAL px — multiply a CSS-px
 * translation by devicePixelRatio first) to a new 1-indexed frame at
 * SEEK_MS_PER_PX, wrapping around the clip. Dragging RIGHT moves to earlier frames
 * so the scene follows the finger (Java: position −= 0.5·vx).
 */
export function panToFrameSeek(
  startFrame: number,
  translationXPx: number,
  frameCount: number,
  msPerPx = SEEK_MS_PER_PX,
  msPerFrame = FRAME_MS,
): number {
  if (frameCount <= 0 || msPerFrame <= 0) return wrapFrame(startFrame, frameCount);
  const delta = -(translationXPx * msPerPx) / msPerFrame;
  return wrapFrame(startFrame + delta, frameCount);
}

/**
 * The 1-indexed frame whose azimuth is circularly closest to `target` — how a
 * neighbor jump keeps the direction you were facing. Frame 1 when the clip has no
 * azimuth.
 */
export function closestFrameToAzimuth(azimuthDeg: number[], target: number): number {
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < azimuthDeg.length; i++) {
    const diff = Math.abs(normalizeDeg(target - azimuthDeg[i]));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best + 1;
}

/**
 * Screen x (px) at which a compass bearing sits given the current heading, or null
 * when it is outside the horizontal FOV. Parity with VideoStreetView.drawAzimuthLine:
 * shown iff 2·|Δaz| < hfov, at x = (0.5 + Δaz/hfov)·width.
 */
export function bearingScreenX(
  bearing: number,
  currentAzimuth: number,
  width: number,
  hfov = STREET_VIEW_HFOV,
): number | null {
  const daz = normalizeDeg(bearing - currentAzimuth);
  if (2 * Math.abs(daz) >= hfov) return null;
  return (0.5 + daz / hfov) * width;
}

/**
 * Screen y (px) of the level (zero-pitch) horizon line for the current pitch, or
 * null when |pitch| is too large to be on screen. Shown iff 2·|pitch| < vfov, at
 * y = (0.5 + pitch/vfov)·height.
 */
export function pitchScreenY(currentPitch: number, height: number, vfov = STREET_VIEW_VFOV): number | null {
  if (Number.isNaN(currentPitch) || 2 * Math.abs(currentPitch) >= vfov) return null;
  return (0.5 + currentPitch / vfov) * height;
}

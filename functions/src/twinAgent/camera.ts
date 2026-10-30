/**
 * The camera the twin agent gives (docs/digital-twin-plan.md §44.1): where the recording's camera stood
 * and how it was turned, in the scene program's own coordinates, as the model worked it out from the
 * pictures. Nothing here decides the view for it — a camera straight over a bench and one looking across
 * a room at a wall are read the same way; only the lens is fixed, the FLIR ONE's. Read by the browser
 * (build_scene scores the program through it) and by the Function (finish writes it into the record the
 * viewer paints through), so the module imports nothing and both compile it.
 *
 * Angles follow the viewer's camera (utils/twinProjection.ts, twinFrame.ts): a three.js Euler
 * (pitch, yaw, roll, 'YXZ'), the camera looking along its −z. Pitch 0 looks level, −90° straight down;
 * yaw 0 looks along the scene's −z, positive turns it to the left (towards −x); roll turns the picture.
 */

/** The FLIR ONE's vertical field of view, degrees (functions/src/twinBuilding.ts FLIR_VFOV_DEG, which
 *  this module cannot import without taking that file's imports along). */
export const AGENT_CAMERA_FOV_V = 55;
/** The thermal grid's width over its height: 120 × 160, portrait. */
export const AGENT_CAMERA_ASPECT = 0.75;
/** How far from the scene's origin a camera may stand, metres: a bench or a room, not a landscape. */
export const AGENT_CAMERA_MAX_M = 50;

export interface AgentCamera {
  /** Metres, in the scene program's coordinates (y up). */
  position: [number, number, number];
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const wrap180 = (deg: number): number => ((((deg + 180) % 360) + 360) % 360) - 180;

/** An angle the model gave under the schema's name or a plainer one ("pitch" for "pitchDeg"): the value
 *  is what matters, the name is not worth a failed build. */
const angle = (o: Record<string, unknown>, name: string): number | null => {
  for (const key of [`${name}Deg`, name, `${name}_deg`]) if (finite(o[key])) return o[key] as number;
  return null;
};

/** The camera as the model passed it, checked; or why it cannot be used. A position given as
 *  {x, y, z} or as a JSON string is read too. */
export function readAgentCamera(raw: unknown): AgentCamera | { error: string } {
  let o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o && typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      o = null;
    }
  }
  if (!o) return { error: 'camera is missing: give its position and its yaw, pitch and roll in degrees.' };
  let p: unknown[] | null = Array.isArray(o.position) ? o.position : null;
  if (!p && o.position && typeof o.position === 'object') {
    const q = o.position as Record<string, unknown>;
    p = [q.x, q.y, q.z];
  }
  if (!p || p.length !== 3 || !p.every(finite))
    return { error: 'camera.position must be [x, y, z] in metres, in the same coordinates as the program.' };
  if (p.some((v) => Math.abs(v as number) > AGENT_CAMERA_MAX_M))
    return { error: `camera.position must be within ${AGENT_CAMERA_MAX_M} m of the origin.` };
  const pitch = angle(o, 'pitch');
  if (pitch === null) return { error: 'camera.pitchDeg is missing: 0 looks level, −90 straight down.' };
  if (pitch < -90 || pitch > 90)
    return { error: 'camera.pitchDeg must be between −90 (straight down) and 90 (straight up).' };
  const yaw = angle(o, 'yaw') ?? 0;
  const roll = angle(o, 'roll') ?? 0;
  return {
    position: [p[0] as number, p[1] as number, p[2] as number],
    yawDeg: wrap180(yaw),
    pitchDeg: pitch,
    rollDeg: wrap180(roll),
  };
}

const rad = (deg: number): number => (deg * Math.PI) / 180;

/** The camera as the twin record and the viewer's photos message carry it (TwinPhotoCamera): radians,
 *  the fixed lens, and no fit behind it. */
export function agentCameraRecord(cam: AgentCamera): {
  position: [number, number, number];
  yaw: number;
  pitch: number;
  roll: number;
  fovV: number;
  aspect: number;
  rms: number;
  inliers: number;
} {
  return {
    position: [cam.position[0], cam.position[1], cam.position[2]],
    yaw: rad(cam.yawDeg),
    pitch: rad(cam.pitchDeg),
    roll: rad(cam.rollDeg),
    fovV: AGENT_CAMERA_FOV_V,
    aspect: AGENT_CAMERA_ASPECT,
    rms: 0,
    inliers: 0,
  };
}

/** The camera in a line, for the build's answer and the record's account. */
export const describeAgentCamera = (cam: AgentCamera): string =>
  `at (${cam.position.map((v) => v.toFixed(3)).join(', ')}) m, yaw ${cam.yawDeg.toFixed(1)}°, pitch ${cam.pitchDeg.toFixed(1)}°, roll ${cam.rollDeg.toFixed(1)}°`;

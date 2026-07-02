// Bridge from the Lab Assistant's tools to the analyzer's ImagePlayer for the operations that live
// INSIDE that component and can't be done from the store alone — placing a thermometer needs the
// current frame's thermal buffer to seed the reading, and seek/play own the playhead (which is a local
// ref, not Zustand). ImagePlayer publishes a controller here on mount and clears it on unmount; the
// tools call through playerRegistry.controller (null when no recording player is active).
export interface PlayerController {
  /** Add a thermometer at [0,1] image coords (x left→right, y top→bottom), reading its value from the
   *  current frame. Optional measuring-area type ('point' | 'rectangle' | 'ellipse'). Returns the new id. */
  addThermometer: (x: number, y: number, areaType?: string) => Promise<string>;
  /** Seek the playhead to a time in seconds (clamped to the clip). Stops playback. */
  seekToTime: (seconds: number) => void;
  /** Start or stop playback. */
  setPlaying: (playing: boolean) => void;
  /** Current playhead: frame index, time, and the clip's last frame / total seconds. */
  getPlayhead: () => { playerIndex: number; seconds: number; lastFrameIndex: number; totalSeconds: number };
}

export const playerRegistry: { controller: PlayerController | null } = { controller: null };

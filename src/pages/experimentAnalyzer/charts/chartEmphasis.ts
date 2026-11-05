import { useMemo } from 'react';
import useCommonStore from '../../../stores/common';

// The ids a chart draws emphasized: the items selected on the frame (any number — Shift / Ctrl / ⌘-click
// builds the selection) plus the one under the pointer. null when there's none, so every series draws at
// full strength; with a set, the series in it are emphasized and the rest fade. The selection keeps its
// highlight after the pointer leaves; hovering previews one more on top of it.
const emphasisSet = (selected: string[], hovered: string | null): Set<string> | null => {
  if (selected.length === 0 && hovered == null) return null;
  const set = new Set(selected);
  if (hovered != null) set.add(hovered);
  return set;
};

/** The thermometers to emphasize on T(t), T(x), T(y) and the colour key: selected on the frame, or hovered
 * on the image / the colour key. */
export function useEmphasizedThermometers(): Set<string> | null {
  const selected = useCommonStore((state) => state.frameSelection.thermometers);
  const hovered = useCommonStore((state) => state.hoveredThermometerId);
  return useMemo(() => emphasisSet(selected, hovered), [selected, hovered]);
}

/** The T(r) lines to emphasize on the profile chart: selected on the frame, or hovered on the image. */
export function useEmphasizedProfileLines(): Set<string> | null {
  const selected = useCommonStore((state) => state.frameSelection.profileLines);
  const hovered = useCommonStore((state) => state.hoveredProfileLineId);
  return useMemo(() => emphasisSet(selected, hovered), [selected, hovered]);
}

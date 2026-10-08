import { message } from 'antd';
import useCommonStore, {
  MAX_OVERLAY_CHARTS,
  MAX_VISIBLE_CHARTS,
  chartsOnPlayer,
  visibleChartCount,
} from '../../../stores/common';
import { ExperimentGraphOption } from '../../../types';

/** What a chart hands its ChartMenu so the menu can offer to move it to / from the player. */
export interface ChartOverlayControl {
  // This chart is laid over the player right now (it's rendered by PlayerChartOverlay, not the grid).
  active: boolean;
  // It can't move right now: onto the player, when that already holds MAX_OVERLAY_CHARTS others; back
  // into the Charts grid, when that already holds MAX_VISIBLE_CHARTS (a chart on the player takes no
  // place there, so the grid can fill up while it's away). The button dims and the click explains.
  blocked: boolean;
  toggle: () => void;
}

// One chart's side of the player overlay (the experiment's chartSettings.onPlayer): whether it's there,
// and the toggle that sends it there / brings it back. Both selectors return booleans, so the per-frame
// store churn re-renders nothing.
export const useChartOverlay = (expId: string, option: ExperimentGraphOption): ChartOverlayControl => {
  const active = useCommonStore((state) => {
    const exp = state.experimentMap.get(expId);
    return chartsOnPlayer(exp?.graphsOptions, exp?.chartSettings?.onPlayer).includes(option);
  });
  const blocked = useCommonStore((state) => {
    const exp = state.experimentMap.get(expId);
    const onPlayer = chartsOnPlayer(exp?.graphsOptions, exp?.chartSettings?.onPlayer);
    return onPlayer.includes(option)
      ? visibleChartCount(exp?.graphsOptions, onPlayer) >= MAX_VISIBLE_CHARTS
      : onPlayer.length >= MAX_OVERLAY_CHARTS;
  });
  const toggleChartOverlay = useCommonStore((state) => state.toggleChartOverlay);
  const toggle = () => {
    if (blocked) {
      message.info(
        active
          ? `The Charts tab shows up to ${MAX_VISIBLE_CHARTS} graphs — turn one off there first.`
          : `The player shows up to ${MAX_OVERLAY_CHARTS} charts — take one off first.`,
      );
      return;
    }
    toggleChartOverlay(expId, option);
  };
  return { active, blocked, toggle };
};

// The corner ✕: turns the chart off, exactly like its chip (on the player, it leaves the player too).
export const useChartClose = (expId: string, option: ExperimentGraphOption) => {
  const toggleGraphOption = useCommonStore((state) => state.toggleGraphOption);
  return () => {
    // toggleGraphOption would turn a chart that is already off back ON; never let a stale ✕ do that.
    if (useCommonStore.getState().experimentMap.get(expId)?.graphsOptions?.includes(option)) {
      toggleGraphOption(expId, option);
    }
  };
};

// Maximize / restore, wherever the chart is: in the Charts panel it fills the panel (maximizedChart); on
// the player it fills the whole frame (maximizedPlayerChart). `toggle` is undefined — no button — for the
// grid's only chart, which fills the panel already; Restore still shows should it be maximized anyway. On
// the player there's always a button: even a lone chart there takes only half the frame.
export const useChartMaximize = (option: ExperimentGraphOption, onPlayer: boolean, alone = false) => {
  const maximized = useCommonStore(
    (state) => (onPlayer ? state.maximizedPlayerChart : state.maximizedChart) === option,
  );
  const setMaximizedChart = useCommonStore((state) => state.setMaximizedChart);
  const setMaximizedPlayerChart = useCommonStore((state) => state.setMaximizedPlayerChart);
  const set = onPlayer ? setMaximizedPlayerChart : setMaximizedChart;
  const toggle = !onPlayer && alone && !maximized ? undefined : () => set(maximized ? null : option);
  return { maximized, toggle };
};

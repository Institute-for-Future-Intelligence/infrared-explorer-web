import { ReactNode, useEffect, useRef, useState } from 'react';
import { CloseOutlined, ExclamationCircleFilled } from '@ant-design/icons';
import { Experiment, ExperimentType, KeyMoment, StoredKeyMoment } from '../../../types';
import useCommonStore, { WorkspaceMode } from '../../../stores/common';
import { saveKeyMoments } from '../../../services/experiments';
import { isStaff } from '../../../utils/staff';

// Canonical stored form (no thumbnail/readings, blank caption dropped, span end kept) for comparing
// what's in the store against what's on the doc, so hydration and redundant re-sets don't rewrite.
const toStored = (list: (KeyMoment | StoredKeyMoment)[]): StoredKeyMoment[] =>
  list.map((m) => {
    const stored: StoredKeyMoment = { recordingIndex: m.recordingIndex, tSeconds: m.tSeconds };
    if (m.endRecordingIndex !== undefined) {
      stored.endRecordingIndex = m.endRecordingIndex;
      stored.endTSeconds = m.endTSeconds;
    }
    if (m.text?.trim()) stored.text = m.text.trim();
    return stored;
  });
const serializeMoments = (list: (KeyMoment | StoredKeyMoment)[]): string =>
  list
    .map(
      (m) =>
        `${m.recordingIndex}|${m.tSeconds}|${m.endRecordingIndex ?? ''}|${m.endTSeconds ?? ''}|${m.text?.trim() ?? ''}`,
    )
    .join(';');
import ExperimentTitle from '../infoSection/experimentTitle';
import Description from '../infoSection/description';
import KeyMoments from '../infoSection/keyMoments';
import AnalyzerActions from '../infoSection/analyzerActions';
import QaPanel from '../infoSection/qaPanel';
import AiReport from '../infoSection/aiReport';
import TwinPanel from '../twin/twinPanel';
import TwinBuildingPanel from '../twin/twinBuildingPanel';

interface Props {
  experiment: Experiment;
  /** The already-wired ChartManager element (charts keep the player's live props — see the player). It
   *  carries its own graph-picker chips and empty state, so the panel just hands it the Charts tab. */
  chart: ReactNode;
  /** A non-owner / signed-out viewer has edited thermometers that live only in the local sandbox — show
   *  a notice inviting them to save a personal copy (which carries the edits). Never set for the owner. */
  sandboxDirty?: boolean;
}

// The analyzer's right-hand workspace (on desktop it sits beside the player; on mobile it stacks under
// it). A FIXED header carries the experiment's identity (title + save, subject, rating / views / share)
// and never changes as you switch tabs; below it a mode switcher over Info (default — the description +
// facts) | Charts (live-coupled to the player) | Ask AI | AI Report. Comments + related live below the
// fold. Ask AI / AI Report stay here (not below the fold) because their interactions (attach the
// on-screen frame, seek from a moment chip) need the player co-visible.
//
// Switching modes UNMOUNTS the inactive ones: charts rebuild from data on remount (their display prefs
// are held in the store so they survive); this dodges the recharts zero-height hazard a display:none-
// hidden chart would hit (see App.css note on ResponsiveContainer).
const WorkspacePanel = ({ experiment, chart, sandboxDirty }: Props) => {
  const user = useCommonStore((state) => state.user);
  const staff = isStaff(user);
  const isOwner = !!user && user.id === experiment.ownerId;
  // Ask AI supports recordings and videos (the server reads each one's thermal data); staff-only.
  const canAskAi = experiment.sourceType === ExperimentType.Recording || experiment.sourceType === ExperimentType.Video;
  const showAskAi = staff && canAskAi;
  const showReport = staff && (isOwner || !!experiment.aiReport);
  // The 3D twin: a recording's tabletop scene (it needs the per-frame visible-light photos only
  // app-captured recordings carry), or a photo set's building rebuilt from its photos' standpoints. A
  // The tab shows for every reader of such an experiment — a signed-in viewer, or a signed-out visitor
  // on a public / unlisted link — whether or not a twin has been built yet: a built twin lives on the
  // experiment doc (twinScene, Function-written) and is shown exactly as the owner left it, and without
  // one the panel says so. Only BUILDING one stays with the owner (and staff while it settles — the
  // panels and the Functions both enforce that).
  const showTwin =
    experiment.sourceType === ExperimentType.Recording || experiment.sourceType === ExperimentType.Photos;
  // Key moments are chapters on a TIMELINE (a time, a span to play); a photo set has neither — its
  // frames are separate shots the browser pages through — so the section is left out rather than
  // offering "Mark this frame" over a strip of unrelated instants.
  const showKeyMoments = experiment.sourceType !== ExperimentType.Photos;

  const mode = useCommonStore((state) => state.workspaceMode);
  const setMode = useCommonStore((state) => state.setWorkspaceMode);
  // Both AI runs outlive their panels — an Ask AI answer streams into qaPanel's session, a report into
  // aiReport's inFlight map — so the strip carries a dot on whichever tab is still working. Without it,
  // switching away looks exactly like having cancelled.
  const qaStreaming = useCommonStore((state) => state.qaStreamingExpId === experiment.id);
  const reportStreaming = useCommonStore((state) => state.reportStreamingExpId === experiment.id);
  const twinRunning = useCommonStore((state) => state.twinRunningExpId === experiment.id);
  const setKeyMoments = useCommonStore((state) => state.setKeyMoments);

  // The sandbox notice is a one-time nudge — once the viewer has seen (and dismissed) it, keep it hidden
  // for the rest of this experiment's session even as further edits keep `sandboxDirty` true. Reset per
  // experiment (below) so a freshly-edited next experiment shows it again.
  const [noteDismissed, setNoteDismissed] = useState(false);

  // Hydrate the key-moment chapters from the doc on navigation. Persisted moments have no thumbnail
  // (they render as pills); the owner's in-session marks add thumbnails on top and don't re-run this.
  useEffect(() => {
    setKeyMoments(
      (experiment.keyMoments ?? []).map((m) => ({ ...m, thumbnail: '', readings: [] })),
      experiment.id,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [experiment.id]);

  // Owner: persist chapter edits (mark / remove / rename) back to the doc in stored form. Guard on the
  // array reference so per-frame store churn is ignored, and compare the canonical serialization against
  // the doc's so the hydration above (which just seeded the store from the doc) doesn't rewrite it.
  useEffect(() => {
    if (!isOwner) return;
    let lastSaved = serializeMoments(experiment.keyMoments ?? []);
    let prevRef = useCommonStore.getState().keyMoments;
    return useCommonStore.subscribe((state) => {
      if (state.keyMoments === prevRef) return;
      prevRef = state.keyMoments;
      // Only persist genuine edits to THIS experiment's moments. A teardown reset (clearAnalysisCaches on
      // unmount) nulls keyMomentsExpId, so it's skipped here rather than writing [] over the doc.
      if (state.keyMomentsExpId !== experiment.id) return;
      const ser = serializeMoments(state.keyMoments);
      if (ser === lastSaved) return;
      lastSaved = ser;
      const stored = toStored(state.keyMoments);
      saveKeyMoments(experiment.id, stored).catch((e) => console.error('failed to save key moments', e));
      // Mirror into the cached experiment so a nav-back (and a clone) sees the update immediately.
      const exp = useCommonStore.getState().experimentMap.get(experiment.id);
      if (exp) useCommonStore.getState().setExperiment(experiment.id, { ...exp, keyMoments: stored });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [experiment.id, isOwner]);
  // The banner's "Save as" link opens the header's single save dialog via this request (see
  // SaveToMyExperiments), rather than rendering a second dialog of its own.
  const requestOpenSaveCopy = useCommonStore((state) => state.requestOpenSaveCopy);
  // Each experiment opens on the Info tab (the default) regardless of the mode left over from a previous
  // one — navigating a related experiment shouldn't inherit the last tab.
  useEffect(() => {
    setMode('info');
    setNoteDismissed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [experiment.id]);
  // Player right-click "Ask about this moment" bumps this; jump to the Ask AI mode so the new chip
  // shows. Each nonce is consumed once, and the mount-time value counts as consumed: navigating to
  // another experiment remounts this panel with the old request still in the store, and re-firing it
  // would override the per-experiment Info reset above.
  const openAskAiRequest = useCommonStore((state) => state.openAnalysisTabRequest);
  const consumedAskAiNonce = useRef(useCommonStore.getState().openAnalysisTabRequest?.nonce ?? 0);
  useEffect(() => {
    if (!openAskAiRequest || openAskAiRequest.nonce <= consumedAskAiNonce.current) return;
    consumedAskAiNonce.current = openAskAiRequest.nonce;
    if (showAskAi) setMode('askAI');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAskAiRequest]);

  // Clamp to an available mode: a gated mode disappearing (or another viewer) falls back to Info (the
  // always-present default). Info and Charts are available to everyone.
  const effective: WorkspaceMode =
    (mode === 'askAI' && !showAskAi) || (mode === 'aiReport' && !showReport) || (mode === 'twin' && !showTwin)
      ? 'info'
      : mode;

  // Only marked while the user is elsewhere: on the tab itself the panel already says what it is doing.
  const busy: Partial<Record<WorkspaceMode, boolean>> = {
    askAI: qaStreaming,
    aiReport: reportStreaming,
    twin: twinRunning,
  };

  const options = [
    { label: 'Info', value: 'info' as const },
    { label: 'Charts', value: 'charts' as const },
    ...(showAskAi ? [{ label: 'Ask AI', value: 'askAI' as const }] : []),
    ...(showReport ? [{ label: 'AI Report', value: 'aiReport' as const }] : []),
    ...(showTwin ? [{ label: '3D Twin', value: 'twin' as const }] : []),
  ];

  return (
    <div className="workspace-panel">
      {/* Fixed identity header — the title + save action; stays put across tab switches. The subject
          shows as a fact in the Info tab; views / rating live in the Info tab footer; share is here. */}
      <div className="workspace-header">
        <ExperimentTitle experiment={experiment} />
      </div>

      {sandboxDirty && !noteDismissed && (
        <div className="workspace-sandbox-note" role="status">
          <ExclamationCircleFilled className="workspace-sandbox-icon" aria-hidden />
          <span>
            Your changes stay on this page. Use{' '}
            <button type="button" className="workspace-sandbox-link" onClick={() => requestOpenSaveCopy()}>
              Save as
            </button>{' '}
            to keep a copy in your own experiments.
          </span>
          <button
            type="button"
            className="workspace-sandbox-close"
            aria-label="Dismiss"
            onClick={() => setNoteDismissed(true)}
          >
            <CloseOutlined />
          </button>
        </div>
      )}

      <div className="workspace-switch" role="tablist" aria-label="Workspace sections">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={effective === o.value}
            className={effective === o.value ? 'workspace-tab workspace-tab-active' : 'workspace-tab'}
            onClick={() => setMode(o.value)}
          >
            {o.label}
            {busy[o.value] && effective !== o.value && (
              <span
                className="workspace-tab-busy"
                title="Still working — this keeps running while you look elsewhere"
                aria-hidden
              />
            )}
          </button>
        ))}
      </div>

      <div className="workspace-body">
        {effective === 'info' && (
          <div className="workspace-info">
            {/* Only the description + key moments scroll; the engagement footer below stays pinned. */}
            <div className="workspace-info-scroll">
              <Description experiment={experiment} />
              {showKeyMoments && <KeyMoments experiment={experiment} />}
            </div>
            {/* Engagement stats (views · comments · rating) pinned to the card bottom, outside the scroll
                region, so they never slide up and out of view when the content above is tall. */}
            <div className="workspace-info-footer">
              <AnalyzerActions experiment={experiment} />
            </div>
          </div>
        )}
        {effective === 'charts' && chart}
        {effective === 'askAI' && <QaPanel key={experiment.id} experiment={experiment} />}
        {effective === 'aiReport' && <AiReport key={experiment.id} experiment={experiment} />}
        {effective === 'twin' &&
          (experiment.sourceType === ExperimentType.Photos ? (
            <TwinBuildingPanel key={experiment.id} experiment={experiment} />
          ) : (
            <TwinPanel key={experiment.id} experiment={experiment} />
          ))}
      </div>
    </div>
  );
};

export default WorkspacePanel;

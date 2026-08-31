import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Empty, Input, Select, message } from 'antd';
import styled from 'styled-components';
import {
  Experiment,
  ExperimentType,
  DEFAULT_MODEL,
  MODEL_KEYS,
  MODEL_LABELS,
  QaModel,
  ReportSampling,
  ReportVerification,
  TemperatureUnit,
  isModelKey,
} from '../../../types';
import useCommonStore, { buildAnalyzerSnapshot } from '../../../stores/common';
import { generateLabReport } from '../../../services/ai';
import { markdownToHtml } from '../../../utils/markdown';
import { isReportStale } from '../../../utils/reportFreshness';
import { formatDuration } from '../../../utils/helpers';
import { splitReportFigures } from '../../../utils/reportFigures';
import { FPS } from '../../../utils/constants';
import { useMappingIndex } from '../hooks';
import { useRebuiltThumbnails } from './useRebuiltThumbnails';
import MomentLightbox, { type PreviewItem } from './momentLightbox';

// Renders the AI report (Markdown -> safe HTML). Fills the tab's full height and scrolls internally;
// tightens the default heading/list spacing so the report reads cleanly inside the analyzer's side
// column. flex:1/min-height:0 lets it consume the height the parent column gives it (see wrapper).
const ReportBody = styled.div`
  font-size: 14px;
  color: black;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 4px;
  /* The side column is narrow; a long unbroken token (a KaTeX span, a URL, a wide number) must wrap
     rather than push the whole report into a horizontal scroll. Tables opt out via .md-table below. */
  overflow-wrap: break-word;
  /* Three distinct heading levels, all at or above the 14px body size — h5 used to render at 13px, so a
     report's subheadings came out SMALLER and weaker than the text they introduced. */
  h4 {
    font-size: 17px;
    margin: 14px 0 4px;
  }
  h5 {
    font-size: 15px;
    margin: 12px 0 4px;
  }
  h6 {
    font-size: 14px;
    margin: 10px 0 4px;
    color: #333;
  }
  p {
    margin: 4px 0;
  }
  ul,
  ol {
    margin: 4px 0;
    padding-left: 20px;
  }
  li {
    margin: 2px 0;
  }
  /* GFM tables: scroll horizontally instead of squishing in the narrow side column. */
  .md-table {
    overflow-x: auto;
    margin: 8px 0;
  }
  table {
    border-collapse: collapse;
    font-size: 12px;
  }
  th,
  td {
    border: 1px solid #e0e0e0;
    padding: 3px 7px;
    text-align: left;
    white-space: nowrap;
  }
  th {
    background: #fafafa;
    font-weight: 600;
  }
  /* A figure the report placed with a [figure: ...] marker: the rendered thermal frame of that instant.
     Kept modest — a thermal frame is 120x160 real pixels, and the figure illustrates the paragraph above
     it rather than taking the report over. Click blows it up in the shared moment lightbox. */
  .report-fig {
    margin: 10px 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .report-fig img {
    width: min(100%, 230px);
    border-radius: 6px;
    background: #f5f5f5;
    display: block;
    cursor: zoom-in;
  }
  .report-fig figcaption {
    font-size: 12px;
    color: #595959;
    max-width: 440px;
  }
  /* The figure's frame isn't renderable (video pixels still downloading, or the fetch failed): a compact
     click-to-seek pill keeps the cited instant reachable instead of leaving a dead hole. */
  .report-fig .fig-pill {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    height: 24px;
    padding: 0 10px;
    border: 1px solid #e8e8e8;
    border-radius: 12px;
    background: #fff;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: #333;
    cursor: pointer;
  }
  .report-fig .fig-pill:hover {
    border-color: #1677ff;
    color: #1677ff;
  }
  /* Frame timing not available (yet): the pill is informational, so no pointer and no hover invite. */
  .report-fig .fig-pill-inert,
  .report-fig .fig-pill-inert:hover {
    cursor: default;
    border-color: #e8e8e8;
    color: #333;
  }
`;

interface Props {
  experiment: Experiment;
}

/** Outcome of one generation. Resolved, never rejected, so an in-flight request nobody is attached to
 *  can't surface as an unhandled rejection. */
type GenOutcome =
  | {
      ok: true;
      report: string;
      model: QaModel;
      instructions: string | null;
      verified: ReportVerification | null;
      vision: boolean;
      sampling: ReportSampling | null;
      generatedAt: number;
    }
  | { ok: false };

/** Server-side cap on the owner's notes (functions/src/index.ts REPORT_INSTRUCTIONS_MAX) — mirrored so
 *  the textarea stops at the same length instead of silently having its tail cut off. */
const INSTRUCTIONS_MAX = 1000;

/** Per-experiment draft key: notes describe THIS experiment's setup, so they must not follow the user
 *  from one experiment to the next the way the model choice does. */
const instructionsKey = (expId: string) => `report-instructions:${expId}`;

/**
 * Generations currently running, keyed by experiment id — MODULE level on purpose.
 *
 * workspacePanel renders the tabs conditionally, so switching to Charts mid-generation UNMOUNTS this
 * panel and used to take the `loading` guard with it: coming back showed an idle "Generate" button, and
 * a second click started a second (billed, rate-limited) run whose result raced the first to overwrite
 * the same Firestore field. Keeping the promise here means a remount re-attaches to the run in progress,
 * and a duplicate can never start.
 */
const inFlight = new Map<string, { promise: Promise<GenOutcome>; model: QaModel; instructions: string }>();

/** Human-readable text for a failed generateLabReport call. */
const failureText = (err: unknown): string => {
  const code = (err as { code?: string })?.code;
  if (code === 'functions/failed-precondition') {
    return (err as { message?: string }).message || 'This experiment has no thermal data to analyze.';
  }
  if (code === 'functions/resource-exhausted') return 'Usage limit reached. Please try again later.';
  return (err as { message?: string })?.message || 'Report generation failed. Please try again.';
};

/**
 * Start (or join) the generation for `expId`. The store patch happens HERE rather than in the component
 * so a report finishing while the panel is unmounted is still kept — otherwise it was thrown away and
 * only reappeared after a refetch.
 */
const startGeneration = (expId: string, model: QaModel, instructions: string, deep: boolean): Promise<GenOutcome> => {
  const existing = inFlight.get(expId);
  if (existing) return existing.promise;
  const promise: Promise<GenOutcome> = (async () => {
    try {
      const res = await generateLabReport(expId, model, instructions, deep);
      const exp = useCommonStore.getState().experimentMap.get(expId);
      // Patch EVERY field the function persisted, not just the report: a value left stale here reappears
      // as soon as anything reads the store instead of the fresh response.
      if (exp) {
        useCommonStore.getState().setExperiment(expId, {
          ...exp,
          aiReport: res.report,
          aiReportModel: model,
          aiReportInstructions: res.instructions,
          aiReportInputsHash: res.inputsHash,
          aiReportVerified: res.verified,
          aiReportInputs: res.inputs,
          aiReportVision: res.vision,
          aiReportSampling: res.sampling,
          // A video showcase whose preset probes the server just materialized (see persistAiReportProbes):
          // mirror the flag so this client's own save logic agrees with the doc it will next read.
          ...(res.customThermometersSet ? { customThermometers: true } : {}),
        });
        // The probes this run persisted into the thermometer subcollection: drop them into the store so
        // they appear on the frame right away — the subcollection is fetched on load, never listened to.
        // Added AFTER the experiment patch above, because addThermometer re-reads the experiment to
        // append to thermometersId (spreading a pre-patch copy here would drop that append).
        res.aiProbesPlaced.forEach((p) => {
          if (useCommonStore.getState().thermometerMap.has(p.id)) return;
          useCommonStore.getState().addThermometer(expId, {
            id: p.id,
            name: p.name,
            x: p.x,
            y: p.y,
            // Placeholder until a player reads the current frame (the refresh nonce below): the real
            // value is frame-dependent and deliberately never travels with the probe.
            value: 0,
            unit: TemperatureUnit.celsius,
            aiPlaced: true,
          });
        });
        if (res.aiProbesPlaced.length > 0) {
          // Same nudge the undo layer uses: the mounted player re-reads every probe's value from the
          // frame it is showing, so the new markers don't sit at 0.0° until the next frame change.
          useCommonStore.getState().setStore((state) => {
            state.thermoRefreshNonce += 1;
          });
          // Fold the injection into the undo BASELINE (the same mechanism the annotation initial load
          // uses): these probes exist as Firestore docs a saved report cites by name, and without this
          // they'd land on the undo stack as an ordinary edit — a Ctrl+Z meant to revert the user's own
          // last placement would instead queue the report's probes for deletion.
          const st = useCommonStore.getState();
          if (st.analyzerHistory.expId === expId && st.analyzerHistory.present) {
            st.rebaselineAnalyzerHistory(buildAnalyzerSnapshot(st, expId));
          }
        }
      }
      return {
        ok: true as const,
        report: res.report,
        model,
        instructions: res.instructions,
        verified: res.verified,
        vision: res.vision,
        sampling: res.sampling,
        generatedAt: res.generatedAt,
      };
    } catch (err) {
      message.error(failureText(err));
      return { ok: false as const };
    } finally {
      inFlight.delete(expId);
    }
  })();
  inFlight.set(expId, { promise, model, instructions });
  return promise;
};

/**
 * AI lab-report tab. Owners generate a physics-grounded report from the experiment's real thermal
 * data (via the generateLabReport callable, which also persists it on the experiment doc); everyone
 * who can view the experiment sees the saved report. Both media types work: a video showcase's single
 * .vir decodes server-side into the same numeric summary a recording's per-frame files do.
 */
const AiReport = ({ experiment }: Props) => {
  const user = useCommonStore((state) => state.user);
  const isOwner = !!user && user.id === experiment.ownerId;

  const [report, setReport] = useState<string>(experiment.aiReport ?? '');
  // Which model produced the currently shown report (for the badge). Starts from the saved value, but a
  // report generated before the model set changed carries a now-removed key (e.g. an old Claude 'opus');
  // drop it so the badge hides instead of rendering a blank label (MODEL_LABELS has no entry for it).
  const [reportModel, setReportModel] = useState<QaModel | undefined>(
    isModelKey(experiment.aiReportModel) ? experiment.aiReportModel : undefined,
  );
  // Seeded from the module map so a remount mid-generation shows the progress notice immediately.
  const [loading, setLoading] = useState(() => inFlight.has(experiment.id));
  // The model the RUNNING generation was started with — not necessarily the picker's current value,
  // which the user may have changed (or which may be another session's default after a remount).
  const [runningModel, setRunningModel] = useState<QaModel | undefined>(() => inFlight.get(experiment.id)?.model);
  // Last failure, kept on screen until the next attempt: the 3s toast was easy to miss, leaving the
  // previous report and its "Generated by …" badge looking like the result of the run that just failed.
  const [failure, setFailure] = useState('');
  // Bumped when this panel starts a run, so the attach effect below picks up the new promise.
  const [attempt, setAttempt] = useState(0);

  // Selected model for the NEXT generation, persisted across sessions. The picker mirrors the Q&A panel;
  // an old saved value under a now-removed key falls back to the default.
  const [model, setModel] = useState<QaModel>(() => {
    const saved = localStorage.getItem('report-model');
    return isModelKey(saved) ? saved : DEFAULT_MODEL;
  });
  const setModelPersist = (m: QaModel) => {
    setModel(m);
    localStorage.setItem('report-model', m);
  };

  // Optional notes for the NEXT run: what to focus on, how long to make it, or setup facts the thermal
  // data cannot show ("the mug held 80 °C water"). Drafted per experiment and kept across sessions, so a
  // half-written note survives a tab switch. Empty is the norm — the button behaves exactly as before.
  const [instructions, setInstructions] = useState(() => localStorage.getItem(instructionsKey(experiment.id)) ?? '');
  const [notesOpen, setNotesOpen] = useState(false);
  // Opt-in deep analysis: the model investigates the data with its own tools before writing. Several
  // model calls and a longer wait, so it is a deliberate choice rather than the default. Remembered
  // across sessions like the model choice.
  const [deep, setDeep] = useState(() => localStorage.getItem('report-deep') === '1');
  const setDeepPersist = (v: boolean) => {
    setDeep(v);
    localStorage.setItem('report-deep', v ? '1' : '0');
  };
  const setInstructionsPersist = (v: string) => {
    const next = v.slice(0, INSTRUCTIONS_MAX);
    setInstructions(next);
    if (next) localStorage.setItem(instructionsKey(experiment.id), next);
    else localStorage.removeItem(instructionsKey(experiment.id));
  };
  // The notes that produced the report currently on screen (from the saved doc, or the run just finished).
  const [reportInstructions, setReportInstructions] = useState<string | null>(experiment.aiReportInstructions ?? null);
  // Figure cross-check for the report on screen. Absent on reports generated before the check existed —
  // shown as nothing at all rather than as a pass.
  const [verified, setVerified] = useState<ReportVerification | null>(experiment.aiReportVerified ?? null);
  // Whether the model was shown the clip's frames. Worth surfacing: a report that identified the objects
  // by looking at them stands on different evidence from one that inferred them from probe names.
  const [usedVision, setUsedVision] = useState<boolean>(!!experiment.aiReportVision);
  // How many frames the report on screen actually rests on. The report is required to say so in its
  // Limitations section, but a caption drawn from the record is a fact rather than a claim.
  const [sampling, setSampling] = useState<ReportSampling | null>(experiment.aiReportSampling ?? null);
  // When the report on screen was written. Seeded from the saved server timestamp, then overwritten by
  // the run that just finished — that timestamp is written by the server and never comes back in the
  // response, so without this a regenerated report showed the date of the one it replaced.
  const [generatedAtMs, setGeneratedAtMs] = useState<number | null>(null);

  // Attach to whichever generation is running for this experiment — the one this panel just started, or
  // one still in flight from before a tab switch unmounted us. `alive` drops the result on unmount; the
  // run itself keeps going and still patches the store.
  useEffect(() => {
    const pending = inFlight.get(experiment.id);
    if (!pending) return;
    let alive = true;
    setLoading(true);
    setRunningModel(pending.model);
    pending.promise.then((res) => {
      if (!alive) return;
      setLoading(false);
      if (res.ok) {
        setReport(res.report);
        setReportModel(res.model);
        setReportInstructions(res.instructions);
        setVerified(res.verified);
        setUsedVision(res.vision);
        setSampling(res.sampling);
        setGeneratedAtMs(res.generatedAt);
        setFailure('');
      } else {
        setFailure('Generation failed. The report below, if any, is the previously saved one.');
      }
    });
    return () => {
      alive = false;
    };
  }, [experiment.id, attempt]);

  const generate = () => {
    const running = inFlight.get(experiment.id);
    if (running) {
      // Joining a run started with DIFFERENT notes would hand back a report written to the old ones,
      // silently, while the edited notes look like they were used. Say so instead.
      if (running.instructions !== instructions.trim())
        message.info('A report is already being generated with the previous notes. Regenerate once it finishes.');
      return;
    }
    setFailure('');
    startGeneration(experiment.id, model, instructions.trim(), deep);
    setAttempt((n) => n + 1);
  };

  const isVideo = experiment.sourceType === ExperimentType.Video;
  const playerFrameRate = useCommonStore((s) => s.playerFrameRate);
  const requestKeyframeSeek = useCommonStore((s) => s.requestKeyframeSeek);
  const { lastFrameIndex, getRecordingIndex, getPlayerIndex } = useMappingIndex(
    experiment.segments,
    experiment.duration,
  );

  // The report split around its [figure: ...] markers, each markdown stretch pre-rendered. KaTeX
  // rendering is not cheap and this component re-renders on every played frame; without the memos the
  // whole report was re-parsed ~20x/second during 4x playback.
  const segments = useMemo(() => splitReportFigures(report), [report]);
  const segmentHtml = useMemo(() => segments.map((s) => (s.kind === 'md' ? markdownToHtml(s.text) : '')), [segments]);

  // Resolve each figure's cited instant (player seconds — the same axis as the report's citations) to a
  // frame: playerIndex to seek, recordingIndex to fetch pixels (identical for a video, whose player
  // index IS the .vir frame index). The mounted player publishes secondsPerFrame; recordings are the
  // fixed 5 fps, so they resolve even before that first publish. Indexed BY SEGMENT (null for markdown
  // stretches) so the render below can pair them without a second counter.
  const figures = useMemo(() => {
    const spf = playerFrameRate?.secondsPerFrame ?? (isVideo ? null : 1 / FPS);
    const last = playerFrameRate?.lastFrame ?? (isVideo ? null : lastFrameIndex);
    let n = 0;
    return segments.map((s) => {
      if (s.kind !== 'figure') return null;
      n += 1;
      const unresolved = spf == null || spf <= 0 || last == null || last < 0;
      const playerIndex = unresolved ? null : Math.min(Math.max(Math.round(s.tSeconds / spf), 0), last);
      return {
        n,
        tSeconds: s.tSeconds,
        caption: s.caption,
        playerIndex,
        recordingIndex: playerIndex == null ? null : isVideo ? playerIndex : getRecordingIndex(playerIndex),
      };
    });
    // getRecordingIndex is a fresh closure every render, but it derives only from segments/duration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, isVideo, playerFrameRate, lastFrameIndex, experiment.segments]);

  // Same pixel pipeline the Q&A moments and key-moment timeline use: recordings fetch the server-baked
  // data_N.png, videos colourise the player's cached .vir frame. '' means tried and failed → pill.
  const figMoments = useMemo(
    () => figures.flatMap((f) => (f && f.recordingIndex != null ? [{ recordingIndex: f.recordingIndex }] : [])),
    [figures],
  );
  const figThumbs = useRebuiltThumbnails(figMoments, experiment);

  // The figure lightbox: same shared component as the Q&A moments, with the report's figures as one
  // pageable group. recordingIndex is the page identity, exactly as in the Q&A panel.
  const [preview, setPreview] = useState<{ items: PreviewItem[]; index: number } | null>(null);
  const stepPreview = useCallback(
    (delta: number) =>
      setPreview((p) => (p ? { ...p, index: (p.index + delta + p.items.length) % p.items.length } : p)),
    [],
  );
  const seekToRecordingIndex = (ri: number) => requestKeyframeSeek(isVideo ? ri : getPlayerIndex(ri));
  // Opened by the figure's ORDINAL, not its frame: two markers can round to the same frame, and matching
  // on recordingIndex would always open the first of them (titled as the wrong figure).
  const openFigurePreview = (figN: number) => {
    const items: PreviewItem[] = figures.flatMap((f) =>
      f && f.recordingIndex != null && figThumbs[f.recordingIndex]
        ? [
            {
              src: figThumbs[f.recordingIndex],
              recordingIndex: f.recordingIndex,
              tSeconds: f.tSeconds,
              label: String(f.n),
            },
          ]
        : [],
    );
    const index = items.findIndex((it) => it.label === String(figN));
    if (index >= 0) setPreview({ items, index });
  };

  // Has the data moved on since the saved report was written? Only meaningful for the report ON SCREEN:
  // a run that just finished used the current inputs by definition.
  const stale = useMemo(
    () => !!report && !loading && report === experiment.aiReport && isReportStale(experiment),
    [report, loading, experiment],
  );
  // aiReportAt was written from the first day and read nowhere, so a reader had no way to tell a report
  // from this morning from one written before the experiment was re-recorded.
  const generatedOn = useMemo(() => {
    const ms = generatedAtMs ?? experiment.aiReportAt?.toMillis?.();
    return ms ? new Date(ms).toLocaleDateString() : '';
  }, [generatedAtMs, experiment.aiReportAt]);

  return (
    // Full-height flex column so the report body stretches to the bottom of the workspace panel instead
    // of being capped to a short box (the workspace gives it a definite height).
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {isOwner && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Button type={report ? 'default' : 'primary'} size="small" loading={loading} onClick={generate}>
            {report ? '✨ Regenerate' : '✨ Generate AI report'}
          </Button>
          {/* Labelled explicitly: this picks the model for the NEXT run, while the line below reads
              "Generated by …" for the saved one — two model names side by side were indistinguishable. */}
          <Select
            size="small"
            value={model}
            onChange={setModelPersist}
            disabled={loading}
            style={{ width: 172 }}
            aria-label="Model to use for the next report"
            title="Model to use for the next report"
            options={MODEL_KEYS.map((k) => ({ value: k, label: MODEL_LABELS[k] }))}
          />
          {/* Notes are optional and usually empty, so they stay folded away rather than taking a
              permanent third of a narrow panel. The dot is the only signal that a draft is waiting. */}
          <Button
            size="small"
            type="text"
            onClick={() => setNotesOpen((v) => !v)}
            aria-expanded={notesOpen}
            title="Optional notes for the AI: what to focus on, or setup details the data can't show"
          >
            {instructions.trim() ? '📝 Notes •' : '📝 Notes'}
          </Button>
          <Checkbox
            checked={deep}
            disabled={loading}
            onChange={(e) => setDeepPersist(e.target.checked)}
            style={{ fontSize: 12 }}
            title="Let the AI investigate the data with its own tools before writing — fits, line profiles, histograms, and looking at specific frames. Slower and costs more."
          >
            Deep analysis
          </Checkbox>
        </div>
      )}
      {isOwner && notesOpen && (
        <div style={{ marginBottom: 10 }}>
          <Input.TextArea
            value={instructions}
            onChange={(e) => setInstructionsPersist(e.target.value)}
            disabled={loading}
            autoSize={{ minRows: 3, maxRows: 8 }}
            maxLength={INSTRUCTIONS_MAX}
            placeholder={
              'Optional. Tell the AI what to focus on, or add setup details the thermal data cannot show — ' +
              'e.g. "the left mug held 80 °C water, the right one 40 °C; room was 22 °C" or ' +
              '"focus on comparing T1 and T2, keep it short".'
            }
            aria-label="Optional notes for the AI report"
          />
          <div style={{ fontSize: 11, color: '#8c8c8c', marginTop: 4 }}>
            Saved with the report so readers can see what the AI was told. Facts you add here are treated as context,
            not measurements — every number still comes from the thermal data.
          </div>
        </div>
      )}
      {/* One live region for the whole status line, so a screen reader is told when a 20-60s generation
          starts and when it finishes instead of sitting silent throughout. */}
      <div role="status" aria-live="polite">
        {loading && (
          <div style={{ fontSize: 12, color: '#595959', marginBottom: 8 }}>
            Analyzing the thermal data with {MODEL_LABELS[runningModel ?? model]}…
            {deep ? ' investigating with tools first, so this can take a few minutes.' : ' this takes ~20–60s.'}
          </div>
        )}
        {failure && !loading && <div style={{ fontSize: 12, color: '#cf1322', marginBottom: 8 }}>{failure}</div>}
        {report && reportModel && !loading && !failure && (
          <div style={{ fontSize: 12, color: '#595959', marginBottom: 8 }}>
            Generated by {MODEL_LABELS[reportModel]}
            {usedVision ? ' · read the thermal frames and photos' : ''}
            {sampling
              ? ` · from ${sampling.used} sampled frame${sampling.used === 1 ? '' : 's'}${sampling.densifiedWindows > 0 ? ' (extra detail where the readings moved fastest)' : ''}`
              : ''}
            {generatedOn && ` · ${generatedOn}`}
          </div>
        )}
      </div>
      {/* Only re-trims and transect edits can be detected here (see reportFreshness), so the wording
          names what changed rather than claiming the whole report is out of date, and the date above is
          left to carry the judgement calls this cannot make. */}
      {report && !loading && stale && (
        <div
          style={{
            fontSize: 12,
            color: '#874d00',
            background: '#fff7e6',
            border: '1px solid #ffe7ba',
            borderRadius: 4,
            padding: '4px 8px',
            marginBottom: 8,
          }}
        >
          The clip or its transects changed after this report was written — regenerate it to match the current data.
        </div>
      )}
      {/* Deliberately worded as "cross-checked", not "verified": the check can only tell that a figure
          does not appear in the measured data, which is the failure worth surfacing — it cannot vouch for
          the physics, or for a number that happens to coincide with a real one. */}
      {report && verified && verified.checked > 0 && !loading && (
        <div style={{ fontSize: 12, marginBottom: 8, color: verified.unmatched.length ? '#d46b08' : '#389e0d' }}>
          {verified.matched}/{verified.checked} figures cross-checked against the measured data
          {verified.unmatched.length > 0 && (
            <span style={{ color: '#8c8c8c' }}> — not found: {verified.unmatched.join(', ')}</span>
          )}
        </div>
      )}
      {/* Shown to every viewer, not just the owner: a report written to particular instructions must not
          read as an unguided one. */}
      {report && reportInstructions && !loading && (
        <details style={{ fontSize: 12, color: '#595959', marginBottom: 8 }}>
          <summary style={{ cursor: 'pointer' }}>Generated with notes from the author</summary>
          <div style={{ whiteSpace: 'pre-wrap', marginTop: 4, paddingLeft: 8, borderLeft: '2px solid #f0f0f0' }}>
            {reportInstructions}
          </div>
        </details>
      )}
      {report ? (
        <ReportBody>
          {segments.map((seg, i) => {
            if (seg.kind === 'md') return <div key={i} dangerouslySetInnerHTML={{ __html: segmentHtml[i] }} />;
            const fig = figures[i];
            if (!fig) return null;
            const thumb = fig.recordingIndex != null ? figThumbs[fig.recordingIndex] : undefined;
            return (
              <figure className="report-fig" key={i}>
                {thumb ? (
                  <img
                    src={thumb}
                    alt={`Thermal frame at ${formatDuration(fig.tSeconds)}`}
                    title="Click to enlarge"
                    onClick={() => openFigurePreview(fig.n)}
                  />
                ) : fig.playerIndex != null ? (
                  <span
                    className="fig-pill"
                    title="Jump to this moment"
                    onClick={() => requestKeyframeSeek(fig.playerIndex!)}
                  >
                    ▶ t = {formatDuration(fig.tSeconds)}
                  </span>
                ) : (
                  // Frame timing not published yet (a video's .vir still downloading, or it failed): no
                  // click affordance until a click could actually do something.
                  <span className="fig-pill fig-pill-inert">t = {formatDuration(fig.tSeconds)}</span>
                )}
                <figcaption>
                  <b>Figure {fig.n}</b> · t = {formatDuration(fig.tSeconds)}
                  {fig.caption ? ` — ${fig.caption}` : ''}
                </figcaption>
              </figure>
            );
          })}
        </ReportBody>
      ) : (
        !loading && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={isOwner ? 'No report yet — click the button above to generate one.' : 'No AI report yet.'}
          />
        )
      )}
      {/* Blows a clicked figure up; shared with the Q&A moments (see momentLightbox). Kept mounted so its
          per-mode render cache and companion probe survive open/close cycles. */}
      <MomentLightbox
        experiment={experiment}
        preview={preview}
        onStep={stepPreview}
        onClose={() => setPreview(null)}
        onSeek={seekToRecordingIndex}
        kindLabel="Figure"
      />
    </div>
  );
};

export default AiReport;

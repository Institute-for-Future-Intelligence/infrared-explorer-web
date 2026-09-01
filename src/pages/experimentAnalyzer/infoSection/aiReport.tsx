import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Empty, Input, Popconfirm, Select, Tooltip, message } from 'antd';
import { CloseOutlined, DeleteOutlined, FileTextOutlined, ThunderboltOutlined } from '@ant-design/icons';
import styled from 'styled-components';
import {
  Experiment,
  ExperimentType,
  DEFAULT_MODEL,
  MODEL_KEYS,
  MODEL_LABELS,
  QaModel,
  TemperatureUnit,
  isModelKey,
  isTextOnlyModel,
} from '../../../types';
import useCommonStore from '../../../stores/common';
import { clearLabReport, generateLabReport } from '../../../services/ai';
import { markdownToHtml } from '../../../utils/markdown';
import { isReportStale } from '../../../utils/reportFreshness';
import { formatDuration } from '../../../utils/helpers';
import { splitReportFigures } from '../../../utils/reportFigures';
import { normalizeReportHeadings } from '../../../utils/reportHeadings';
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
  /* The report's type scale. markdownToHtml maps #/##/### onto h4/h5/h6, so those three tags are the
     report's TITLE, its SECTION headings and any sub-heading inside a section — three steps that must be
     told apart at a glance, and each clearly above the 14px body (a heading that matches its own body
     text reads as a bold sentence, which is what this scale replaces).

     h4 — the report's own title, once, at the top. Largest and heaviest, with a hairline rule under it
     so the document has a masthead rather than just a big first line. */
  h4 {
    font-size: 21px;
    font-weight: 700;
    line-height: 1.25;
    letter-spacing: -0.01em;
    color: #141414;
    margin: 2px 0 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid #f0f0f0;
  }
  /* h5 — a section heading ("Observations"). Clearly larger and heavier than the body, with generous
     space above so the eye finds the section breaks while scrolling. */
  h5 {
    font-size: 16px;
    font-weight: 700;
    line-height: 1.3;
    color: #1f1f1f;
    margin: 20px 0 6px;
  }
  /* h6 — a sub-heading inside a section. Body size, but semibold and darker with the letter-spacing that
     reads as a label, so it separates from the paragraphs without competing with the section above it. */
  h6 {
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.01em;
    color: #434343;
    margin: 12px 0 4px;
  }
  /* Only the report's very first heading loses its top margin. Scoped to the first segment wrapper on
     purpose: the body is rendered as one div per markdown stretch between figures, so a bare
     :first-child would also flatten every section heading that happens to follow a figure. */
  > div:first-child > h4:first-child,
  > div:first-child > h5:first-child {
    margin-top: 0;
  }
  p {
    margin: 6px 0;
    line-height: 1.55;
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
    width: min(100%, 150px);
    border-radius: 6px;
    background: #f5f5f5;
    display: block;
    cursor: zoom-in;
  }
  .report-fig figcaption {
    font-size: 11px;
    color: #595959;
    max-width: 380px;
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
  /* Blinking caret at the end of the text while the report is still streaming in (mirrors the Q&A). */
  .report-cursor {
    display: inline-block;
    width: 6px;
    margin-left: 1px;
    animation: report-blink 1s step-start infinite;
  }
  @keyframes report-blink {
    50% {
      opacity: 0;
    }
  }
`;

/**
 * The owner's controls above the report, grouped by what they DO rather than laid out as one flat row of
 * equal-looking buttons: the action first, then a divider, then the settings that shape the next run,
 * then the destructive Clear pushed to the far end so it is never adjacent to Regenerate.
 *
 * Wraps rather than overflows — the analyzer's side column gets narrow, and the model picker alone is
 * half of it.
 */
const Toolbar = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;

  /* Separates "do it" from "configure it". A hairline, not a border on the group: at this size a boxed
     group reads as heavier than the buttons it contains. */
  .tb-divider {
    width: 1px;
    align-self: stretch;
    min-height: 18px;
    background: #f0f0f0;
    margin: 0 2px;
  }
  /* Wide enough for the longest model label without truncation, but allowed to shrink on a narrow
     panel instead of forcing the row to wrap early. */
  .tb-model {
    width: 172px;
    min-width: 120px;
    flex: 0 1 auto;
  }
  .tb-deep {
    font-size: 12px;
    white-space: nowrap;
  }
  /* Far end of the row, and last in the tab order of the settings group. */
  .tb-clear {
    margin-left: auto;
  }
`;

/** The "this model can't see images" line under the toolbar, with its dismiss button. A quiet row rather
 *  than a boxed alert: it states a fact about the current selection, not an error. */
const Notice = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 4px;
  font-size: 12px;
  color: #8c8c8c;
  margin: -4px 0 8px;

  /* Nudged up so the × sits on the notice's first line rather than centred against a wrapped block, and
     kept quiet until hovered — dismissing is available, not encouraged. */
  .notice-close {
    flex: none;
    margin-top: -2px;
    color: #bfbfbf;
  }
  .notice-close:hover {
    color: #595959;
  }
`;

interface Props {
  experiment: Experiment;
}

/** Outcome of one generation, as the panel needs it. Resolved, never rejected, so an in-flight request
 *  nobody is attached to can't surface as an unhandled rejection. The run's other outputs (model,
 *  cross-check, vision, sampling, timestamp) are persisted server-side and patched into the store — the
 *  panel itself only shows the text and the notes it was written to. */
type GenOutcome = { ok: true; report: string; instructions: string | null } | { ok: false; cancelled?: boolean };

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
interface InFlight {
  promise: Promise<GenOutcome>;
  model: QaModel;
  instructions: string;
  /** Aborts the callable's stream, which the function reads as its cancellation signal. */
  controller: AbortController;
  /** The report as streamed so far — kept here so a remount can show what has arrived already. */
  draft: string;
  /** True once the text is complete and the server moved on to cross-checking (and possibly rewriting)
   *  the figures — the panel stops implying tokens are still arriving. */
  finalizing: boolean;
  /** The mounted panel's subscriber, re-attached on remount (only one panel per experiment is mounted). */
  onDraft?: (text: string) => void;
}

/** How often a streaming draft may re-render, in ms.
 *
 *  Every update re-runs heading normalization, figure splitting, and markdownToHtml (which renders KaTeX)
 *  over the WHOLE accumulated report — O(n) work per token, so O(n²) across a generation, and each SSE
 *  chunk arrives in its own task, so React cannot batch them. Unthrottled, a long report visibly janks
 *  the analyzer (the same parse was already too expensive at ~20/s during playback — see the memo
 *  comments below). ~8 updates/second still reads as live typing. */
const DRAFT_RENDER_MS = 125;

const inFlight = new Map<string, InFlight>();

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
  // Cancellation and the live draft live in the module map beside the promise, for the same reason the
  // promise does: a tab switch unmounts this panel, and both must survive it — coming back should show
  // the text still arriving and a Cancel button that still works.
  const controller = new AbortController();
  const entry: InFlight = {
    promise: null as unknown as Promise<GenOutcome>,
    model,
    instructions,
    controller,
    draft: '',
    finalizing: false,
  };
  // Throttle what reaches React: entry.draft always holds the newest text (so a remount is never behind),
  // but the panel re-parses at most every DRAFT_RENDER_MS. A trailing timer flushes the tail, otherwise
  // the last few tokens of a report would sit unrendered until the run resolved.
  let lastPaint = 0;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  const paint = () => {
    lastPaint = Date.now();
    entry.onDraft?.(entry.draft);
  };
  const promise: Promise<GenOutcome> = (async () => {
    try {
      const res = await generateLabReport(
        expId,
        model,
        instructions,
        deep,
        (text) => {
          entry.draft = text;
          const since = Date.now() - lastPaint;
          if (since >= DRAFT_RENDER_MS) {
            if (trailing) {
              clearTimeout(trailing);
              trailing = null;
            }
            paint();
          } else if (!trailing) {
            trailing = setTimeout(() => {
              trailing = null;
              paint();
            }, DRAFT_RENDER_MS - since);
          }
        },
        controller.signal,
        () => {
          // Text complete; the server is now cross-checking the figures (and may rewrite them).
          if (trailing) {
            clearTimeout(trailing);
            trailing = null;
          }
          entry.finalizing = true;
          paint();
        },
      );
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
          // These probes are Firestore documents the server wrote and the saved report cites by name —
          // not a user edit to be undone. Folding them into every snapshot keeps them out of the undo
          // stack entirely; without it a Ctrl+Z meant to revert the user's own last placement would
          // queue the report's probes for deletion instead.
          const st = useCommonStore.getState();
          if (st.analyzerHistory.expId === expId) {
            st.reconcileAnalyzerHistoryProbes({
              add: res.aiProbesPlaced.map((p) => ({
                id: p.id,
                name: p.name,
                x: p.x,
                y: p.y,
                value: 0,
                unit: TemperatureUnit.celsius,
                aiPlaced: true,
              })),
            });
          }
        }
      }
      return { ok: true as const, report: res.report, instructions: res.instructions };
    } catch (err) {
      // A run the user cancelled is not a failure to report — they know, and the toast would be noise.
      if (controller.signal.aborted) return { ok: false as const, cancelled: true };
      message.error(failureText(err));
      return { ok: false as const };
    } finally {
      // A pending trailing paint would fire into a run that no longer exists (and, after a cancel,
      // re-show text the panel has already dropped).
      if (trailing) clearTimeout(trailing);
      inFlight.delete(expId);
    }
  })();
  entry.promise = promise;
  inFlight.set(expId, entry);
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
  // The report as it streams in. Shown INSTEAD of the saved report while a run is live, so the reader
  // watches it being written rather than a spinner; replaced by the authoritative text when the run
  // resolves (the server snaps figure markers and may rewrite the draft once, so the stream is a
  // preview, not the result). Seeded from the module map so a remount mid-run shows what has arrived.
  const [draft, setDraft] = useState(() => inFlight.get(experiment.id)?.draft ?? '');
  // Text complete, server still cross-checking the figures: the report on screen is final but the run
  // is not, so the caret stops and the status line says what is actually happening.
  const [finalizing, setFinalizing] = useState(() => inFlight.get(experiment.id)?.finalizing ?? false);

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

  // Attach to whichever generation is running for this experiment — the one this panel just started, or
  // one still in flight from before a tab switch unmounted us. `alive` drops the result on unmount; the
  // run itself keeps going and still patches the store.
  useEffect(() => {
    const pending = inFlight.get(experiment.id);
    if (!pending) return;
    let alive = true;
    setLoading(true);
    setRunningModel(pending.model);
    // Take over as the run's draft subscriber — on a remount this re-attaches to a stream already in
    // progress, and the seeded state above has whatever arrived while we were unmounted.
    setDraft(pending.draft);
    setFinalizing(pending.finalizing);
    pending.onDraft = (text) => {
      if (!alive) return;
      setDraft(text);
      setFinalizing(pending.finalizing);
    };
    pending.promise.then((res) => {
      if (!alive) return;
      setLoading(false);
      setDraft('');
      setFinalizing(false);
      if (res.ok) {
        setReport(res.report);
        setReportInstructions(res.instructions);
        setFailure('');
      } else if (res.cancelled) {
        // Cancelling restores the previously saved report (still on screen underneath), so say what
        // happened rather than leaving the panel looking like a failure.
        setFailure('Generation cancelled. The report below, if any, is the previously saved one.');
      } else {
        setFailure('Generation failed. The report below, if any, is the previously saved one.');
      }
    });
    return () => {
      alive = false;
      // Stop feeding a component that is going away; the run itself keeps streaming into entry.draft
      // (so a remount picks up where this left off) and still patches the store when it lands. Cleanup
      // runs before the next effect body, so this never clears a subscriber the re-run just installed.
      pending.onDraft = undefined;
    };
  }, [experiment.id, attempt]);

  const cancelGeneration = () => {
    const running = inFlight.get(experiment.id);
    if (!running) return;
    running.controller.abort();
  };

  const [clearing, setClearing] = useState(false);
  const clearReport = async () => {
    setClearing(true);
    try {
      const { clearedProbeIds } = await clearLabReport(experiment.id);
      const store = useCommonStore.getState();
      const exp = store.experimentMap.get(experiment.id);
      if (exp) {
        // Mirror the deletion the callable just made, field for field, so nothing reads a report the
        // document no longer has.
        const cleared = { ...exp };
        delete cleared.aiReport;
        delete cleared.aiReportModel;
        delete cleared.aiReportAt;
        delete cleared.aiReportInstructions;
        delete cleared.aiReportInputsHash;
        delete cleared.aiReportInputs;
        delete cleared.aiReportVerified;
        delete cleared.aiReportVision;
        delete cleared.aiReportSampling;
        store.setExperiment(experiment.id, cleared);
      }
      // The probes that report placed are gone from Firestore; take their markers off the frame too.
      clearedProbeIds.forEach((id) => store.removeThermometer(experiment.id, id));
      if (clearedProbeIds.length > 0 && store.analyzerHistory.expId === experiment.id) {
        // Mirror image of the injection path: the documents are gone server-side, so no snapshot may
        // still contain them — a Ctrl+Z restoring one would have the auto-save recreate a probe whose
        // report no longer exists (and, because the suggestion budget counts probes already on the
        // experiment, quietly deny the next report its own).
        store.reconcileAnalyzerHistoryProbes({ removeIds: clearedProbeIds });
      }
      setReport('');
      setReportInstructions(null);
      setFailure('');
      message.success(
        clearedProbeIds.length > 0
          ? `Report cleared, along with ${clearedProbeIds.length} probe${clearedProbeIds.length === 1 ? '' : 's'} it placed.`
          : 'Report cleared.',
      );
    } catch (err) {
      message.error((err as { message?: string })?.message || 'Could not clear the report. Please try again.');
    } finally {
      setClearing(false);
    }
  };

  // Whether the model picked for the NEXT run can be shown the frames at all. The DeepSeek models are
  // text-only: they write from the numbers, never from the pictures.
  const canSeeImages = !isTextOnlyModel(model);

  // Dismissal of the text-only notice below. Component state, never persisted, and reset on every model
  // change: the notice is about the model that is selected RIGHT NOW, so choosing a text-only model
  // again — or returning to this tab — must state its limitation again rather than silently honouring a
  // dismissal from another session. Switching between the two DeepSeek models counts as a change.
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  useEffect(() => {
    setNoticeDismissed(false);
  }, [model]);

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
  // While a run streams, the draft IS the report on screen. Figures are parsed out of it the same way,
  // so a marker the model has already written renders its thumbnail as the text flows past it. Heading
  // levels are normalized first, so a report saved under the old "### Suggested title" format renders
  // with the same title/section hierarchy as one written today.
  const shownReport = draft || report;
  const segments = useMemo(() => splitReportFigures(normalizeReportHeadings(shownReport)), [shownReport]);
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
  return (
    // Full-height flex column so the report body stretches to the bottom of the workspace panel instead
    // of being capped to a short box (the workspace gives it a definite height).
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {isOwner && (
        <Toolbar>
          {/* THE action, alone on the left. Primary until a report exists, then default — once there is
              something to read, regenerating is a choice rather than the thing to do. */}
          <Button
            type={report ? 'default' : 'primary'}
            size="small"
            icon={<ThunderboltOutlined />}
            loading={loading}
            onClick={generate}
          >
            {report ? 'Regenerate' : 'Generate report'}
          </Button>
          {/* Only while a run is live. Danger-styled because it throws away work in progress — but it
              also stops the spend, which is the point: a deep run is several model calls. */}
          {loading && (
            <Button size="small" danger onClick={cancelGeneration} title="Stop generating and keep the saved report">
              Cancel
            </Button>
          )}

          {/* Everything from here to the spacer configures the NEXT run rather than doing anything, so
              it sits behind a divider at a lighter weight — the row used to read as five equal buttons. */}
          <span className="tb-divider" aria-hidden="true" />

          {/* Labelled explicitly: this picks the model for the NEXT run. */}
          <Select
            size="small"
            value={model}
            onChange={setModelPersist}
            disabled={loading}
            className="tb-model"
            aria-label="Model to use for the next report"
            title="Model to use for the next report"
            options={MODEL_KEYS.map((k) => ({ value: k, label: MODEL_LABELS[k] }))}
          />
          {/* Notes are optional and usually empty, so they stay folded away rather than taking a
              permanent third of a narrow panel. The dot is the only signal that a draft is waiting. */}
          <Button
            size="small"
            type={notesOpen ? 'default' : 'text'}
            icon={<FileTextOutlined />}
            onClick={() => setNotesOpen((v) => !v)}
            aria-expanded={notesOpen}
            title="Optional notes for the AI: what to focus on, or setup details the data can't show"
          >
            Notes{instructions.trim() ? ' •' : ''}
          </Button>
          {/* A real tooltip rather than a title attribute: the difference between the two modes decides
              whether the reader waits 30 seconds or several minutes, so it should be readable on hover
              without a browser's 1-second delay and its one-line truncation. */}
          <Tooltip
            title={
              <span style={{ fontSize: 12 }}>
                <b>Off</b> — one pass: the AI writes from the summary and the analysis the server already computed
                (fits, events, gradients) plus a few sampled frames. ~20–60 s.
                <br />
                <br />
                <b>On</b> — the AI investigates first, with its own tools: re-fit a curve over a window it chooses, read
                a line profile or histogram, pull in extra frames the sampling skipped
                {canSeeImages ? ', look at specific frames' : ''}. Then it writes. Several model calls, so it costs more
                and takes a few minutes — worth it when the clip has something specific you want dug into.
              </span>
            }
            styles={{ root: { maxWidth: 460 } }}
          >
            <Checkbox
              checked={deep}
              disabled={loading}
              onChange={(e) => setDeepPersist(e.target.checked)}
              className="tb-deep"
            >
              Deep analysis
            </Checkbox>
          </Tooltip>

          {/* Destructive, so it lives at the far end of the row — never adjacent to Regenerate, which is
              the click it would otherwise be mistaken for. The confirmation is where the probe removal
              is disclosed: that is the part a reader would not expect. */}
          {report && !loading && (
            <Popconfirm
              title="Clear this report?"
              description="The saved report and the probes it placed are deleted for everyone. This can't be undone."
              okText="Clear"
              okButtonProps={{ danger: true, loading: clearing }}
              onConfirm={clearReport}
            >
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                loading={clearing}
                className="tb-clear"
                title="Delete the saved report"
              >
                Clear
              </Button>
            </Popconfirm>
          )}
        </Toolbar>
      )}
      {/* A text-only model (the DeepSeek models) never receives the frames — it writes from the numbers
          alone. Said here, next to the picker, because "read the thermal frames and photos" appears in
          the status line of reports written by the other models and its absence is easy to miss.
          Dismissable, but deliberately NOT remembered: it describes the model currently selected, so
          picking that model again (or coming back to the tab) states the limitation again. */}
      {isOwner && !canSeeImages && !noticeDismissed && (
        <Notice>
          {/* Kept to one line at a normal panel width; the full "what it does and doesn't get" wording
              lives in the hover title, exactly as the Q&A panel's identical warning does. */}
          <span
            title={`${MODEL_LABELS[model]} is text-only: it never receives the thermal frames or the visible-light photos, so its report is written from the numbers alone and it cannot say what the objects are.`}
          >
            ⚠️ {MODEL_LABELS[model]} can’t see frames — its report is numbers only.
          </span>
          <Button
            size="small"
            type="text"
            icon={<CloseOutlined />}
            className="notice-close"
            onClick={() => setNoticeDismissed(true)}
            aria-label="Dismiss this notice"
            title="Dismiss"
          />
        </Notice>
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
            {finalizing ? (
              <>Cross-checking the figures against the measured data…</>
            ) : draft ? (
              <>Writing the report with {MODEL_LABELS[runningModel ?? model]}…</>
            ) : (
              <>
                Analyzing the thermal data with {MODEL_LABELS[runningModel ?? model]}…
                {deep ? ' investigating with tools first, so this can take a few minutes.' : ' this takes ~20–60s.'}
              </>
            )}
          </div>
        )}
        {failure && !loading && <div style={{ fontSize: 12, color: '#cf1322', marginBottom: 8 }}>{failure}</div>}
      </div>
      {/* Only re-trims and transect edits can be detected here (see reportFreshness), so the wording
          names what changed rather than claiming the whole report is out of date. */}
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
      {shownReport ? (
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
          {/* Streaming caret, same convention as the Q&A answers. Drops the moment the text is complete,
              even though the run continues (the figure cross-check is not more text arriving). */}
          {draft && !finalizing && <span className="report-cursor">▍</span>}
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

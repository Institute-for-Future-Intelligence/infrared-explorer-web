/**
 * Where the time goes in one AI lab report — one structured line per run, so the proposal to make the
 * report faster (app repo docs/proposals/ai-report-latency.md, §7.0) argues from a distribution instead
 * of from estimates.
 *
 * WHAT IS RECORDED. The wall-clock of every stage generateLabReport goes through (access checks, the
 * frame load, the image seed, each investigation round, the write-up and its first token, the figure
 * check, the correction pass, the persist), the shape of the investigation (which tools were called,
 * how many images were viewed, whether the write-up was streamed or came back whole inside a tool
 * round), and how the figures fared against the data (checked / matched / the unmatched snippets by
 * kind). Everything is a count or a duration; the only free text is the unmatched snippets, which are
 * fragments of the generated report, never of the user's own writing.
 *
 * WHERE IT GOES. The line is written to stdout as JSON (`event: 'ai_report_timing'`), which Cloud
 * Logging parses into jsonPayload exactly as the `ai_usage` lines are — Logs Explorer, a logs-based
 * metric and a BigQuery sink all read it without code. The same record is written to
 * `aiReportAudit/{ref}__{ms}` (TTL 180 days) so staff can open the unmatched snippets next to the
 * experiment in the Firestore console and classify them by hand in a `review` field; see the proposal
 * §7.0.1 for the queries. Nothing in the app or the website reads either copy.
 *
 * HOW IT IS WIRED. The recorder rides in an AsyncLocalStorage scope opened by withReportTiming, the
 * same device withAiUsageScope uses for the account tier: the deep-report loop and the model callers
 * are shared helpers that know nothing about the request, and `reportTiming()` lets them record a
 * round without a parameter threaded through four signatures. Outside a scope it hands back a fresh,
 * detached recorder, so a helper under test or on another surface records into the void and never
 * throws. The wrapper also owns the outcome: a thrown `cancelled` HttpsError is a cancel, any other
 * throw is a failure, and the line is written in a `finally` so a run that dies half-way still counts.
 *
 * Pure apart from the Node async-hooks scope: no Firestore, no console. The caller supplies the sink.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { HttpsError, type CallableRequest, type CallableResponse } from 'firebase-functions/v2/https';

export type ReportOutcome = 'ok' | 'cancelled' | 'failed';

/** One unmatched figure, as the verifier reports it (analysis.ts CitedValue). */
export interface UnmatchedFigure {
  text: string;
  kind: 'temperature' | 'time' | 'rate';
}

/** The verifier's result, in the shape generateLabReport already holds. */
export interface VerificationLike {
  checked: number;
  matched: number;
  unmatched: readonly UnmatchedFigure[];
}

/** Scalar facts about the run, set as they become known. */
export interface ReportTimingFacts {
  /** expId today; the labReports id once the direct path exists. */
  ref: string | null;
  /** Which transport brought the frames. */
  path: 'expId' | 'runId';
  model: string | null;
  tier: string | null;
  /** The write-up length the prompt asked for (B5). Always 'full' until stage 1 ships the short form. */
  length: 'brief' | 'full';
  /** Whether the model was actually shown images. */
  vision: boolean | null;
  axis: string | null;
  sourceType: string | null;
  /** The analysis sampling record (digest.sampling). */
  sampling: Record<string, unknown> | null;
}

export interface RoundRecord {
  ms: number;
  /** The tools the model called in this round; empty when it answered with neither tools nor text. */
  tools: readonly string[];
  /** Images handed back by view_frames in this round. */
  images: number;
}

export interface ReportTimingSummary extends ReportTimingFacts {
  event: 'ai_report_timing';
  outcome: ReportOutcome;
  /** The thrown error's message (≤ 200 chars) on a failure; absent otherwise. */
  error?: string;
  /** The deep loop ran (or the single-pass fallback did): a model was actually called. */
  modelStarted: boolean;
  /** The deep loop threw and the report came from the single-pass fallback. */
  fallback: boolean;
  checked: number | null;
  matched: number | null;
  /** At most 12, as persisted on the experiment. */
  unmatched: UnmatchedFigure[];
  unmatchedByKind: { temperature: number; time: number; rate: number };
  reportChars: number | null;
  /** `[figure:` markers that survived sanitizing. */
  figures: number | null;
  /** Investigation rounds by kind: a round whose every tool was view_frames is a view round. */
  rounds: { numeric: number; view: number };
  roundMs: number[];
  /** Per round, the tool names joined with ',' — a flat list because Firestore refuses nested arrays. */
  roundTools: string[];
  /** Calls per tool name across the run. */
  toolCalls: Record<string, number>;
  imagesViewed: number;
  /** False when the model wrote the report inside an investigation round, where nothing is streamed
   *  and the reader sees a blank panel until it ends; true for the forced final write-up. */
  writeStreamed: boolean | null;
  correction: { ms: number; before: number; after: number; applied: boolean } | null;
  timing: {
    accessMs: number | null;
    loadMs: number | null;
    seedMs: number | null;
    /** First report text delta after the write-up call began; null when it was not streamed. */
    writeTtftMs: number | null;
    writeMs: number | null;
    verifyMs: number | null;
    persistMs: number | null;
    totalMs: number;
  };
}

type StageName = 'access' | 'load' | 'seed' | 'verify' | 'persist';

const ERROR_MESSAGE_MAX = 200;

/** Count the figure markers the client will render ("[figure: t = 48 s | caption]" lines). */
export function countFigureMarkers(report: string): number {
  return (report.match(/^\s*\[figure:/gim) ?? []).length;
}

export class ReportTimingRecorder {
  readonly startedAt: number;
  /** Who the run belongs to — kept OFF the log line and written only to the audit document. */
  ownerId: string | null = null;

  private readonly facts: ReportTimingFacts = {
    ref: null,
    path: 'expId',
    model: null,
    tier: null,
    length: 'full',
    vision: null,
    axis: null,
    sourceType: null,
    sampling: null,
  };
  private readonly stages: Record<StageName, number | null> = {
    access: null,
    load: null,
    seed: null,
    verify: null,
    persist: null,
  };
  private readonly roundList: RoundRecord[] = [];
  private modelStartedFlag = false;
  private fallbackFlag = false;
  private verificationResult: VerificationLike | null = null;
  private reportText: string | null = null;
  private correctionRecord: ReportTimingSummary['correction'] = null;
  private writeStartedAt: number | null = null;
  private firstTextAt: number | null = null;
  private writeMs: number | null = null;
  private writeStreamed: boolean | null = null;
  private outcome: ReportOutcome | null = null;
  private errorMessage: string | undefined;
  private finishedAt: number | null = null;

  constructor(
    startedAt: number = Date.now(),
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = startedAt;
  }

  set(facts: Partial<ReportTimingFacts>): void {
    Object.assign(this.facts, facts);
  }

  /** A stage's duration. Pass the measured milliseconds; the stages are not consecutive (the model
   *  rounds sit between seed and verify), so nothing here is "since the last mark". */
  stage(name: StageName, ms: number): void {
    this.stages[name] = Math.max(0, Math.round(ms));
  }

  /** The deep loop (or the fallback) is about to call a model. */
  modelStarted(): void {
    this.modelStartedFlag = true;
  }

  /** The deep loop failed and the single-pass fallback is writing the report instead. */
  fallback(): void {
    this.fallbackFlag = true;
  }

  /** One investigation round: the model call plus its tool executions. */
  round(record: RoundRecord): void {
    this.roundList.push({ ms: Math.max(0, Math.round(record.ms)), tools: [...record.tools], images: record.images });
  }

  /**
   * The write-up call is starting (the forced final turn, or the single-pass fallback). Resets the
   * first-token mark so a fallback after a half-streamed deep write-up measures its own first token.
   */
  writeStarted(): void {
    this.writeStartedAt = this.now();
    this.firstTextAt = null;
    this.writeMs = null;
    this.writeStreamed = true;
  }

  /** The first report text delta reached the client. A no-op before writeStarted or after the first. */
  firstText(): void {
    if (this.writeStartedAt !== null && this.firstTextAt === null) this.firstTextAt = this.now();
  }

  writeDone(): void {
    if (this.writeStartedAt !== null && this.writeMs === null) this.writeMs = this.now() - this.writeStartedAt;
  }

  /** A provisional write-up turned out to be an investigation round after all (tools were called): the
   *  marks it left are not a write-up and are dropped. */
  writeAbandoned(): void {
    this.writeStartedAt = null;
    this.firstTextAt = null;
    this.writeMs = null;
    this.writeStreamed = null;
  }

  /** The model wrote the whole report inside an investigation round, where nothing is streamed. */
  writeUnstreamed(ms: number): void {
    this.writeStartedAt = null;
    this.firstTextAt = null;
    this.writeMs = Math.max(0, Math.round(ms));
    this.writeStreamed = false;
  }

  /**
   * The streaming channel the write-up is forwarded to, wrapped so the first text delta marks the
   * time-to-first-token. A Proxy rather than a copy: CallableResponse carries more than sendChunk
   * (the abort signal, acceptsStreaming) and all of it must keep working through the wrapper.
   */
  watchStream<T extends CallableResponse>(response: T | undefined): T | undefined {
    if (!response) return response;
    return new Proxy(response, {
      get: (target, prop, receiver) => {
        if (prop === 'sendChunk') {
          return (chunk: unknown) => {
            const text = (chunk as { text?: unknown } | null)?.text;
            if (typeof text === 'string' && text.length > 0) this.firstText();
            return target.sendChunk(chunk as never);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  correction(record: NonNullable<ReportTimingSummary['correction']>): void {
    this.correctionRecord = { ...record, ms: Math.max(0, Math.round(record.ms)) };
  }

  /** The verification the report was finally persisted with (after any correction). */
  verification(result: VerificationLike | null): void {
    this.verificationResult = result;
  }

  /** The report as finally persisted. */
  report(text: string): void {
    this.reportText = text;
  }

  finish(outcome: ReportOutcome, err?: unknown): void {
    this.outcome = outcome;
    this.finishedAt = this.now();
    if (outcome === 'failed') {
      const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
      this.errorMessage = message.slice(0, ERROR_MESSAGE_MAX);
    }
  }

  summary(): ReportTimingSummary {
    const byKind = { temperature: 0, time: 0, rate: 0 };
    for (const u of this.verificationResult?.unmatched ?? []) byKind[u.kind] = (byKind[u.kind] ?? 0) + 1;
    const rounds = { numeric: 0, view: 0 };
    const toolCalls: Record<string, number> = {};
    let imagesViewed = 0;
    for (const r of this.roundList) {
      const view = r.tools.length > 0 && r.tools.every((t) => t === 'view_frames');
      if (view) rounds.view++;
      else rounds.numeric++;
      for (const t of r.tools) toolCalls[t] = (toolCalls[t] ?? 0) + 1;
      imagesViewed += r.images;
    }
    const end = this.finishedAt ?? this.now();
    return {
      event: 'ai_report_timing',
      outcome: this.outcome ?? 'failed',
      ...(this.errorMessage !== undefined ? { error: this.errorMessage } : {}),
      ...this.facts,
      modelStarted: this.modelStartedFlag,
      fallback: this.fallbackFlag,
      checked: this.verificationResult?.checked ?? null,
      matched: this.verificationResult?.matched ?? null,
      unmatched: (this.verificationResult?.unmatched ?? []).slice(0, 12).map((u) => ({ text: u.text, kind: u.kind })),
      unmatchedByKind: byKind,
      reportChars: this.reportText === null ? null : this.reportText.length,
      figures: this.reportText === null ? null : countFigureMarkers(this.reportText),
      rounds,
      roundMs: this.roundList.map((r) => r.ms),
      roundTools: this.roundList.map((r) => r.tools.join(',')),
      toolCalls,
      imagesViewed,
      writeStreamed: this.writeStreamed,
      correction: this.correctionRecord,
      timing: {
        accessMs: this.stages.access,
        loadMs: this.stages.load,
        seedMs: this.stages.seed,
        writeTtftMs:
          this.writeStartedAt !== null && this.firstTextAt !== null ? this.firstTextAt - this.writeStartedAt : null,
        writeMs: this.writeMs,
        verifyMs: this.stages.verify,
        persistMs: this.stages.persist,
        totalMs: Math.max(0, end - this.startedAt),
      },
    };
  }
}

// ------------------------------------------------------------------- scope

const timingScope = new AsyncLocalStorage<ReportTimingRecorder>();

/** The current run's recorder — or a detached one outside withReportTiming, so helpers never branch. */
export function reportTiming(): ReportTimingRecorder {
  return timingScope.getStore() ?? new ReportTimingRecorder();
}

export interface ReportTimingSink {
  /** The structured line (stdout → Cloud Logging). */
  log: (summary: ReportTimingSummary) => void;
  /** The audit copy; receives the recorder for the fields kept off the log line (ownerId). */
  persist?: (summary: ReportTimingSummary, recorder: ReportTimingRecorder) => Promise<void>;
}

function isCancel(err: unknown): boolean {
  return err instanceof HttpsError && err.code === 'cancelled';
}

/**
 * Run a callable handler inside a timing scope and write the record when it ends, however it ends.
 * The sink must never make a report fail: both its halves are guarded and only warned about.
 */
export function withReportTiming<T = any, R = unknown>(
  handler: (request: CallableRequest<T>, response?: CallableResponse) => Promise<R>,
  sink: ReportTimingSink,
  warn: (message: string, err: unknown) => void = (message, err) => console.warn(message, err),
): (request: CallableRequest<T>, response?: CallableResponse) => Promise<R> {
  return (request, response) => {
    const recorder = new ReportTimingRecorder();
    return timingScope.run(recorder, async () => {
      try {
        const out = await handler(request, response);
        recorder.finish('ok');
        return out;
      } catch (err) {
        recorder.finish(isCancel(err) ? 'cancelled' : 'failed', err);
        throw err;
      } finally {
        let summary: ReportTimingSummary | null = null;
        try {
          summary = recorder.summary();
          sink.log(summary);
        } catch (err) {
          warn('ai_report_timing log failed', err);
        }
        if (summary && sink.persist) {
          try {
            await sink.persist(summary, recorder);
          } catch (err) {
            warn('aiReportAudit write failed', err);
          }
        }
      }
    });
  };
}

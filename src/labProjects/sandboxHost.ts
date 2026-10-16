/*
 * The hidden page the AI's own analysis code runs in (the run_code tool,
 * browserTools.ts): the app's sandbox page (core/sandboxPage.ts, a verbatim
 * copy) in an iframe with `sandbox="allow-scripts"` — no origin, no storage,
 * no network (the page's own content-security policy), no access to this
 * page — the same isolation as the analyzer's digital twin
 * (pages/experimentAnalyzer/twin/twinFrame.ts). The website's version of the
 * app's CodeSandboxHost.tsx and sandbox.ts: the WebView bridge the page was
 * written for (window.ReactNativeWebView.postMessage out, injectJavaScript
 * in) is swapped for postMessage both ways by a small bootstrap script put
 * in front of the page's runtime; the page's own code is not changed.
 *
 * One run at a time; the page is kept for a while after a run (its decoded
 * frames serve the next), and let go after RUNAWAY_LIMIT_MS of a run that
 * never finishes.
 */

import {
  PAGE_START_LIMIT_MS,
  RUNAWAY_LIMIT_MS,
  parseSandboxMessage,
  sandboxHtml,
  type TakeMeta,
} from './core/sandboxPage';

/** How long the page is kept after a run, for the next one to reuse its decoded frames. */
const IDLE_UNMOUNT_MS = 120_000;

export interface SandboxRequest {
  code: string;
  takes: TakeMeta[];
  /**
   * Frames `from`, `from + step`, … up to `to` (indexed from 0) of take
   * `take`, delivered in chunks as they are read: each chunk's first index,
   * its frames encoded (sandboxPage.encodeFrames; the k-th is frame
   * start + k × step) and the offsets within it of unreadable frames.
   */
  loadFrames(
    take: number,
    from: number,
    to: number,
    step: number,
    deliver: (start: number, b64: string, missing: number[]) => void,
  ): Promise<void>;
  /** The visible-light picture of frame `i` of take `take`, as a data URL; null when there is none. */
  loadVisible(take: number, i: number): Promise<string | null>;
  onPrint(text: string): void;
  onPicture(picture: { index: number; caption: string; png: string }): void;
  /** The values earlier runs of this project saved, name → JSON. */
  saved: Record<string, string>;
  /** The code saved a value (JSON), or dropped one (null). */
  onSave(name: string, json: string | null): void;
}

export interface SandboxOutcome {
  ok: boolean;
  /** What the code returned, as JSON; null for nothing. */
  returned: string | null;
  error: string | null;
  ms: number;
  framesRead: number;
  /** The run was stopped at the time limit. */
  timedOut: boolean;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Run {
  id: string;
  req: SandboxRequest;
  done: Deferred<SandboxOutcome>;
  timer: ReturnType<typeof setTimeout>;
  /**
   * Frames handed to the page so far, counted here as each request for
   * frames completes: the page's own count never arrives from a run stopped
   * as stuck, and that is the run whose count says what took the time.
   */
  framesRead: number;
}

/**
 * The bridge the page is given instead of the WebView's: what it posts goes
 * to the parent, and what the parent posts as {__sb: 'run' | 'frames' |
 * 'answer', …} is routed to the page's own window.__sb (the entry points
 * the app's injected scripts call: sandboxPage.ts runScript, framesScript,
 * answerScript).
 */
const BOOTSTRAP =
  "window.ReactNativeWebView = {postMessage: function (s) { window.parent.postMessage(s, '*'); }};" +
  "window.addEventListener('message', function (e) {" +
  '  var m = e.data;' +
  "  if (!m || typeof m !== 'object' || !m.__sb || !window.__sb) { return; }" +
  "  if (m.__sb === 'run') { window.__sb.run(m.runId, m.code, m.takes, m.saved); }" +
  "  else if (m.__sb === 'frames') { window.__sb.frames(m.take, m.start, m.b64, m.missing, m.step); }" +
  "  else if (m.__sb === 'answer') { window.__sb.answer(m.id, m.ok, m.payload); }" +
  '});';

/** The sandbox page with the bootstrap in front of its runtime. */
export function hostedSandboxHtml(): string {
  const html = sandboxHtml();
  const at = html.indexOf('<body><script>');
  if (at < 0) {
    throw new Error('The sandbox page has changed shape.');
  }
  return `${html.slice(0, at)}<body><script>${BOOTSTRAP}</script><script>${html.slice(at + '<body><script>'.length)}`;
}

/** The imperative side: one host for the page, outliving every run. */
class Controller {
  private frame: HTMLIFrameElement | null = null;
  private ready: Deferred<void> | null = null;
  private run: Run | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private runs = 0;
  private readonly onMessage = (e: MessageEvent) => {
    if (!this.frame || e.source !== this.frame.contentWindow || typeof e.data !== 'string') {
      return;
    }
    this.handle(e.data);
  };

  private post(message: Record<string, unknown>): void {
    this.frame?.contentWindow?.postMessage(message, '*');
  }

  /** The page is mounted and has said it is ready. */
  private async ensurePage(): Promise<void> {
    if (!this.ready) {
      this.ready = deferred<void>();
      const d = this.ready;
      try {
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.referrerPolicy = 'no-referrer';
        frame.title = 'AI code sandbox';
        frame.setAttribute('aria-hidden', 'true');
        frame.tabIndex = -1;
        frame.style.cssText =
          'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;border:0;';
        frame.srcdoc = hostedSandboxHtml();
        window.addEventListener('message', this.onMessage);
        document.body.appendChild(frame);
        this.frame = frame;
      } catch (err) {
        d.reject(new Error(`The code sandbox could not be made: ${(err as Error)?.message ?? err}`));
      }
      setTimeout(() => d.reject(new Error('The code sandbox did not start.')), PAGE_START_LIMIT_MS);
    }
    await this.ready.promise;
  }

  /** Let the page go (a stopped run, a failure, or idleness); the next run mounts a fresh one. */
  private dropPage(): void {
    this.ready = null;
    window.removeEventListener('message', this.onMessage);
    this.frame?.remove();
    this.frame = null;
  }

  private scheduleIdle(): void {
    if (this.idle) {
      clearTimeout(this.idle);
    }
    this.idle = setTimeout(() => {
      this.idle = null;
      if (!this.run) {
        this.dropPage();
      }
    }, IDLE_UNMOUNT_MS);
  }

  private settle(outcome: SandboxOutcome): void {
    const r = this.run;
    if (!r) {
      return;
    }
    clearTimeout(r.timer);
    this.run = null;
    r.done.resolve(outcome);
  }

  async start(req: SandboxRequest): Promise<SandboxOutcome> {
    if (this.idle) {
      clearTimeout(this.idle);
      this.idle = null;
    }
    try {
      await this.ensurePage();
    } catch (err) {
      this.dropPage();
      return { ok: false, returned: null, error: (err as Error).message, ms: 0, framesRead: 0, timedOut: false };
    }
    const id = `run${++this.runs}`;
    const done = deferred<SandboxOutcome>();
    const timer = setTimeout(() => {
      // a loop that never yields never hears a message: the page itself goes
      const minutes = Math.round(RUNAWAY_LIMIT_MS / 60_000);
      const read = this.run?.id === id ? this.run.framesRead : 0;
      // A run that read frames the whole time was not stuck but slow: the
      // model is told the count and the pace, so its next try reads less.
      // One that read none was looping.
      const why =
        read > 0
          ? `The code was still running after ${minutes} minutes and was stopped. In that time it read ${read} frames (about ${Math.round(RUNAWAY_LIMIT_MS / read)} ms a frame): reading frames is what takes the time, so read fewer — a larger \`every\` or \`step\`, or a narrower from..to.`
          : `The code was still running after ${minutes} minutes without reading a frame and was stopped as stuck (a loop that never ends?).`;
      this.settle({ ok: false, returned: null, error: why, ms: RUNAWAY_LIMIT_MS, framesRead: read, timedOut: true });
      this.dropPage();
    }, RUNAWAY_LIMIT_MS);
    this.run = { id, req, done, timer, framesRead: 0 };
    this.post({ __sb: 'run', runId: id, code: req.code, takes: req.takes, saved: req.saved });
    const outcome = await done.promise;
    this.scheduleIdle();
    return outcome;
  }

  private handle(data: string): void {
    const m = parseSandboxMessage(data);
    if (!m) {
      return;
    }
    if (m.t === 'ready') {
      this.ready?.resolve();
      return;
    }
    const r = this.run;
    if (!r) {
      return;
    }
    switch (m.t) {
      case 'need':
        if (m.what === 'frames') {
          r.req
            .loadFrames(m.take, m.from, m.to, m.step, (start, b64, missing) => {
              if (this.run === r) {
                this.post({ __sb: 'frames', take: m.take, start, b64, missing, step: m.step });
              }
            })
            .then(
              () => {
                if (this.run === r) {
                  // the request's frames, all handed over by now (the page never asks past the take)
                  r.framesRead += m.to >= m.from ? Math.floor((m.to - m.from) / m.step) + 1 : 0;
                  this.post({ __sb: 'answer', id: m.id, ok: true, payload: null });
                }
              },
              (err) =>
                this.run === r &&
                this.post({ __sb: 'answer', id: m.id, ok: false, payload: (err as Error)?.message ?? String(err) }),
            );
        } else {
          r.req.loadVisible(m.take, m.i).then(
            (url) => this.run === r && this.post({ __sb: 'answer', id: m.id, ok: true, payload: url }),
            (err) =>
              this.run === r &&
              this.post({ __sb: 'answer', id: m.id, ok: false, payload: (err as Error)?.message ?? String(err) }),
          );
        }
        return;
      case 'print':
        if (m.runId === r.id) {
          r.req.onPrint(m.s);
        }
        return;
      case 'picture':
        if (m.runId === r.id) {
          r.req.onPicture({ index: m.index, caption: m.caption, png: m.png });
        }
        return;
      case 'save':
        if (m.runId === r.id) {
          r.req.onSave(m.name, m.json);
        }
        return;
      case 'done':
        if (m.runId === r.id) {
          this.settle({
            ok: m.ok,
            returned: m.returned,
            error: m.error,
            ms: m.ms,
            framesRead: m.framesRead,
            timedOut: false,
          });
        }
        return;
      default:
        return;
    }
  }
}

let controller: Controller | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** Run the AI's code in the sandbox, after any run already under way. */
export function runInSandbox(req: SandboxRequest): Promise<SandboxOutcome> {
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('The code sandbox is not available.'));
  }
  if (!controller) {
    controller = new Controller();
  }
  const c = controller;
  const turn = queue.then(() => c.start(req));
  queue = turn.catch(() => undefined);
  return turn;
}

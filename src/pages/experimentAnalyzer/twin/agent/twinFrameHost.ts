/**
 * The twin viewer frame (twinFrame.ts) run off screen for the agent's build_scene tool
 * (docs/digital-twin-plan.md §43.5): the same sandboxed iframe TwinBuildingViewer shows, with the same
 * handshake — the frame says 'ready' on the window, the host hands it a MessagePort — and the same
 * messages (build, photos, verify, snapshot), but no one looking at it: the host only waits for the
 * frame's answers. One frame per program, as the viewer keeps it (§30.3): a build replaces the frame,
 * so whatever a program did lives and dies with its document. The iframe has a real size and sits off
 * the left edge of the page, because a frame of zero size has no canvas to draw the ID pass or a
 * snapshot into.
 */
import { TWIN_FRAME_HTML } from '../twinFrame';
import type { TwinPhotosMessage } from '../../../../utils/twinProjection';

const READY_MS = 20_000;
const BUILD_MS = 30_000;
const ANSWER_MS = 20_000;

export interface FrameBuilt {
  meshes: number;
  parts: { name: string; kinds: string[]; center: number[]; min: number[]; max: number[] }[];
  unnamedMeshes: number;
  size: number;
  settled: unknown;
}

export interface FrameVerified {
  photo: number;
  mask: Uint16Array | null;
  names: string[];
}

type Waiter = {
  type: string;
  resolve: (d: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: number;
};

export class TwinFrameHost {
  private iframe: HTMLIFrameElement | null = null;
  private port: MessagePort | null = null;
  private waiters: Waiter[] = [];
  private buildId = 0;

  /** A fresh frame, connected. */
  async open(): Promise<void> {
    this.close();
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.style.cssText =
      'position:fixed;left:-10000px;top:0;width:480px;height:640px;opacity:0;pointer-events:none;border:0';
    this.iframe = iframe;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        window.removeEventListener('message', onWindow);
        reject(new Error('The 3D viewer did not start in time.'));
      }, READY_MS);
      const onWindow = (e: MessageEvent) => {
        if (!iframe.contentWindow || e.source !== iframe.contentWindow) return;
        const d = e.data as { type?: unknown; message?: unknown } | null;
        if (!d || typeof d !== 'object') return;
        if (d.type === 'failed') {
          window.clearTimeout(timer);
          window.removeEventListener('message', onWindow);
          reject(
            new Error(`The 3D viewer could not start: ${typeof d.message === 'string' ? d.message : 'unknown error'}`),
          );
          return;
        }
        if (d.type !== 'ready') return;
        window.clearTimeout(timer);
        window.removeEventListener('message', onWindow);
        const channel = new MessageChannel();
        channel.port1.onmessage = (m) => this.onMessage(m.data as Record<string, unknown>);
        this.port = channel.port1;
        iframe.contentWindow.postMessage({ type: 'connect' }, '*', [channel.port2]);
        resolve();
      };
      window.addEventListener('message', onWindow);
    });
    iframe.srcdoc = TWIN_FRAME_HTML;
    document.body.appendChild(iframe);
    await ready;
  }

  close(): void {
    for (const w of this.waiters) {
      window.clearTimeout(w.timer);
      w.reject(new Error('The 3D viewer was closed.'));
    }
    this.waiters = [];
    this.port?.close();
    this.port = null;
    this.iframe?.remove();
    this.iframe = null;
  }

  private onMessage(d: Record<string, unknown>): void {
    if (!d || typeof d !== 'object' || typeof d.type !== 'string') return;
    if (d.type === 'leaving') {
      this.close();
      return;
    }
    // A build's answer is `built` or `error`; anything else answers the waiter of its own type.
    const type = d.type === 'error' && this.waiters.some((w) => w.type === 'built') ? 'built' : d.type;
    const i = this.waiters.findIndex((w) => w.type === type);
    if (i < 0) return;
    const [w] = this.waiters.splice(i, 1);
    window.clearTimeout(w.timer);
    w.resolve(d);
  }

  private wait(type: string, ms: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`The 3D viewer did not answer (${type}) in time.`));
      }, ms);
      this.waiters.push({ type, resolve, reject, timer });
    });
  }

  private post(msg: object): void {
    if (!this.port) throw new Error('The 3D viewer is not open.');
    this.port.postMessage(msg);
  }

  /** Run a program; the frame's report, or the error it reported. */
  async build(code: string, parts: { name: string; kind: string }[]): Promise<FrameBuilt> {
    const buildId = ++this.buildId;
    const answer = this.wait('built', BUILD_MS);
    this.post({ type: 'build', buildId, code, mode: 'realistic', unit: 'C', parts, subjectKind: 'apparatus' });
    const d = await answer;
    if (d.type === 'error')
      throw new Error(typeof d.message === 'string' ? d.message : 'The program could not be run.');
    const parts0 = Array.isArray(d.parts) ? (d.parts as FrameBuilt['parts']) : [];
    return {
      meshes: typeof d.meshes === 'number' ? d.meshes : 0,
      parts: parts0,
      unnamedMeshes: typeof d.unnamedMeshes === 'number' ? d.unnamedMeshes : 0,
      size: typeof d.size === 'number' ? d.size : 0,
      settled: d.settled ?? null,
    };
  }

  /** The projected photos (the frame answers with its sampled surfaces, which are waited for so the
   *  cameras are in place before a verify). */
  async photos(photos: TwinPhotosMessage['photos']): Promise<void> {
    const answer = this.wait('sampled', ANSWER_MS);
    this.post({ type: 'photos', photos });
    await answer;
  }

  async verify(photo: number): Promise<FrameVerified> {
    const answer = this.wait('verified', ANSWER_MS);
    this.post({ type: 'verify', photo });
    const d = await answer;
    return {
      photo,
      mask: d.mask instanceof Uint16Array ? d.mask : null,
      names: Array.isArray(d.names) ? d.names.map((n) => (typeof n === 'string' ? n : '')) : [],
    };
  }

  /** A JPEG of the view as drawn (a data URL), or null. */
  async snapshot(): Promise<string | null> {
    const id = Date.now();
    const answer = this.wait('snapshot', ANSWER_MS);
    this.post({ type: 'snapshot', id });
    const d = await answer.catch(() => null);
    return d && typeof d.dataUrl === 'string' ? d.dataUrl : null;
  }
}

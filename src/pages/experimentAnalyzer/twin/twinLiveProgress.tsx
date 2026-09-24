/**
 * What a twin run is doing right now (docs/digital-twin-plan.md §28.5), for the owner waiting on it: a
 * line for the phase — the pictures being read; the model writing the scene (which one, for how long,
 * how much so far); the measured surfaces being traced, photo by photo; the save — and, while the model
 * writes, a box with its answer made readable as it arrives (utils/twinLive.ts), kept scrolled to the
 * newest line unless the owner has scrolled up to read, so a build of a minute or more is seen to move.
 * Before the Function has said anything (a fixed-camera build's motion gate runs first, on the client),
 * the run's own progress line stands in. Shared by the build forms, toolbars and the revision thread.
 */
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { renderTwinLive } from '../../../utils/twinLive';
import { TWIN_MODEL_LABELS } from './twinModels';
import type { TwinLive, TwinRun } from './twinRun';

/** The box shows this much of the end of what has been written: a scene program runs to 100k characters,
 *  and the newest lines are what say it is moving. */
const SHOWN_CHARS = 6000;

const modelLabel = (key: string | undefined) =>
  key ? ((TWIN_MODEL_LABELS as Record<string, string>)[key] ?? key) : 'The AI model';

const count = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** The phase line, at `now`. */
function twinLiveStatus(live: TwinLive, now: number): string {
  switch (live.phase) {
    case 'photos':
      return 'Reading the pictures…';
    case 'scene': {
      const secs = Math.max(0, Math.round((now - live.phaseAt) / 1000));
      const sofar = live.text.length
        ? ` · ${count(live.text.length)} characters so far`
        : live.thought.length
          ? ' · thinking'
          : '';
      return `${modelLabel(live.modelKey)} is writing the scene… ${secs} s${sofar}`;
    }
    case 'surfaces':
      return `Tracing the surfaces the camera measured… ${live.done ?? 0}/${live.total ?? 0} photos`;
    case 'saving':
      return 'Saving the twin…';
  }
}

const tailOf = (s: string) => (s.length > SHOWN_CHARS ? `…${s.slice(-SHOWN_CHARS)}` : s);

interface Props {
  run: TwinRun;
  /** Before the phase line (the revision thread's spinner). */
  icon?: ReactNode;
  /** The phase line's class, when not the build status line's. */
  className?: string;
}

const TwinLiveProgress = ({ run, icon, className }: Props) => {
  const live = run.live;
  // The seconds tick while the model writes; every chunk re-renders the line anyway.
  const [, tick] = useState(0);
  // Once the owner has pressed Stop the run only checks whether the twin was saved regardless (§31.7):
  // its own word ("Stopping…") stands, the seconds stop and the model's output goes.
  const quiet = run.stopping;
  const ticking = !run.done && !quiet && live?.phase === 'scene';
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  const text = live && !quiet ? twinLiveStatus(live, Date.now()) : run.progress;
  const rendered = useMemo(() => (live?.text ? renderTwinLive(live.text) : ''), [live?.text]);
  const answer = tailOf(rendered);
  const thought = tailOf(live?.thought ?? '');
  const hasBox = !run.done && !quiet && !!(answer || thought);

  // Follow the newest line — unless the owner scrolled up to read something, until they come back down.
  const boxRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    const box = boxRef.current;
    if (box && follow.current) box.scrollTop = box.scrollHeight;
  }, [answer, thought]);
  const onScroll = () => {
    const box = boxRef.current;
    if (box) follow.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
  };

  if (!text && !hasBox) return null;
  return (
    <>
      {text && (
        <div className={className ?? 'twin-status twin-status-live'}>
          {icon}
          <span>{text}</span>
        </div>
      )}
      {hasBox && (
        <div className="twin-live-box" ref={boxRef} onScroll={onScroll}>
          {thought && (
            <span className="twin-live-thought">
              {thought}
              {answer ? '\n\n' : ''}
            </span>
          )}
          {answer}
        </div>
      )}
    </>
  );
};

export default TwinLiveProgress;

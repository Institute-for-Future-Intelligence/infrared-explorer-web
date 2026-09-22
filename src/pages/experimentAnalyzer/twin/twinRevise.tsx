/**
 * The revision thread of a digital twin (docs/digital-twin-plan.md §19, §24): the owner tells the AI what is
 * wrong with the twin — "the roof is flat", "that dish is the bottle being filled" — and an AI model makes it
 * again with the note in front of it, keeping the rest. Both kinds of twin have one, under their About: a
 * scene program's (twinBuildingViewer — the model rewrites the program from the same pictures, §19) and a
 * fixed-camera twin's (twinPanel — the model revises its analysis of the same frame, the owner's corrections
 * applied, §24). The host says how: `revise` sends the note and stores what comes back. The owner picks
 * which AI model gets the note (§20), starting from the one that made the twin as it stands; the request the
 * twin was built to goes with it. Each round stays on the record as the note, the model it went to and that
 * model's account of what it changed, so every reader sees how the twin came to be; only an owner with
 * staff access (who may also Regenerate) gets the box.
 *
 * A revision is a twinRun.ts run like a build — one per experiment at a time, surviving a tab switch,
 * stoppable — flagged `revision`, so it reports here rather than in the build toolbar. A note that
 * failed or was stopped stays in the thread, marked as not applied, until it is sent again or dismissed.
 *
 * A scene program's dialog belongs to the Realistic view — the model's shape is what a note is about. The
 * viewer hides About on the thermal views without unmounting it, so a half-written note survives a switch
 * of view.
 */
import { useState } from 'react';
import { Button, Input, Select } from 'antd';
import { LoadingOutlined, SendOutlined } from '@ant-design/icons';
import { Experiment, TwinRevision } from '../../../types';
import useCommonStore from '../../../stores/common';
import {
  TWIN_DEFAULT_MODEL,
  TWIN_MODELS,
  TWIN_MODEL_LABELS,
  type TwinBuildKind,
  type TwinModelKey,
  isTwinModelKey,
} from './twinModels';
import { type TwinRun, startTwinRun, stopTwinRun, useTwinRun } from './twinRun';

/** The server's cap on a note (TWIN_REVISION_NOTE_MAX in functions/src/twinBuilding.ts). */
const NOTE_MAX = 1000;
/** A problem the viewer reported is quoted at most this long: the start of a message says what failed. */
const PROBLEM_QUOTE_MAX = 300;

const when = (at: number) =>
  at > 0
    ? new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';

interface Props {
  experiment: Experiment;
  /** The rounds so far, oldest first. */
  revisions: TwinRevision[];
  /** The kind of twin, and so the AI models a note may go to. */
  kind: TwinBuildKind;
  /** The model that made the twin as it stands, when it is offered for `kind`: the note goes to it unless
   *  the owner picks another (it knows the twin best). */
  madeBy: TwinModelKey | null;
  /** The owner with staff access — the one who may send a note; everyone else reads the thread. */
  canRevise: boolean;
  /** What the viewer reported about the twin as it ran (a scene program's error, or an early stop): offered
   *  for quoting in a note, since it is the most exact account there is of what went wrong. */
  problem?: string | null;
  /** What the Revise button says the chosen model (its label) does with the note. */
  reviseTitle: (model: string) => string;
  /** The revision itself, run as a twinRun.ts task: reports progress through `set`, throws to fail, hands
   *  `signal` to whatever it waits on, and stores the record that comes back. */
  revise: (note: string, model: TwinModelKey, set: (progress: string) => void, signal: AbortSignal) => Promise<void>;
}

const TwinRevise = ({ experiment, revisions, kind, madeBy, canRevise, problem = null, reviseTitle, revise }: Props) => {
  const user = useCommonStore((state) => state.user);
  const ownerViewing = !!user && user.id === experiment.ownerId;
  const run = useTwinRun(experiment.id);
  const running = !!run && !run.done;
  const pending = run && !run.done && run.revision ? run : null;
  // The last revision, when it ended without being applied — until the owner sends it again or lets it go.
  const [dismissed, setDismissed] = useState<TwinRun | null>(null);
  const unapplied = run && run.done && run.revision && (run.error || run.stopped) && run !== dismissed ? run : null;
  const [draft, setDraft] = useState('');
  // The AI model the next note goes to: the owner's pick, else the one that made the twin as it stands
  // (which knows it best), else the kind's usual model.
  const [picked, setPicked] = useState<TwinModelKey | null>(null);
  const model: TwinModelKey = picked ?? madeBy ?? TWIN_DEFAULT_MODEL[kind];
  if (!canRevise && !revisions.length) return null;

  /** The label of a model a round of the thread went to, when it says (rounds from before §20 do not). */
  const labelOf = (key: string | undefined) => (isTwinModelKey(key, kind) ? TWIN_MODEL_LABELS[key] : null);
  const send = () => {
    const note = draft.trim();
    if (!note || running) return;
    const to = model;
    startTwinRun(experiment.id, (set, signal) => revise(note, to, set, signal), { note, model: to });
    setDraft('');
  };
  const sendAgain = (r: TwinRun) => {
    setDraft(r.revision?.note ?? '');
    const to = r.revision?.model;
    if (isTwinModelKey(to, kind)) setPicked(to);
    setDismissed(r);
  };
  const quoteProblem = () => {
    if (!problem) return;
    const quote = problem.length > PROBLEM_QUOTE_MAX ? `${problem.slice(0, PROBLEM_QUOTE_MAX)}…` : problem;
    setDraft((d) => `${d.trim() ? `${d.trim()}\n\n` : ''}The viewer reported: ${quote}`.slice(0, NOTE_MAX));
  };
  const who = ownerViewing ? 'You' : 'Owner';

  return (
    <div className="twin-revise">
      {(revisions.length > 0 || pending || unapplied) && (
        <div className="twin-revise-thread" aria-live="polite">
          {revisions.map((r, i) => (
            <div className="twin-revise-turn" key={`${r.at}-${i}`}>
              <div className="twin-revise-note">{r.feedback}</div>
              <div className="twin-revise-meta">
                {[who, when(r.at), labelOf(r.modelKey) && `to ${labelOf(r.modelKey)}`].filter(Boolean).join(' · ')}
              </div>
              <div className="twin-revise-reply">{r.changes || 'The AI did not say what it changed.'}</div>
            </div>
          ))}
          {pending && (
            <div className="twin-revise-turn">
              <div className="twin-revise-note">{pending.revision!.note}</div>
              <div className="twin-revise-reply twin-revise-live">
                <LoadingOutlined spin />
                <span>{pending.progress}</span>
              </div>
              {canRevise && (
                <div className="twin-revise-links">
                  <Button
                    size="small"
                    danger
                    onClick={() => stopTwinRun(experiment.id)}
                    title="Stop revising — the AI stops too, and the twin is left as it was"
                  >
                    Stop
                  </Button>
                </div>
              )}
            </div>
          )}
          {unapplied && (
            <div className="twin-revise-turn">
              <div className="twin-revise-note twin-revise-note-unapplied">{unapplied.revision!.note}</div>
              <div className="twin-revise-meta">
                {['Not applied', labelOf(unapplied.revision!.model) && `to ${labelOf(unapplied.revision!.model)}`]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
              <div className={unapplied.stopped ? 'twin-revise-reply' : 'twin-revise-error'}>
                {unapplied.stopped ? 'Stopped — the twin was left as it was.' : unapplied.error}
              </div>
              {canRevise && (
                <div className="twin-revise-links">
                  <Button type="link" size="small" onClick={() => sendAgain(unapplied)} disabled={running}>
                    Edit and send again
                  </Button>
                  <Button type="link" size="small" onClick={() => setDismissed(unapplied)}>
                    Dismiss
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {canRevise && (
        <div className="twin-revise-compose">
          <div className="twin-revise-lead">
            {revisions.length
              ? 'Anything else wrong with the twin?'
              : 'Something wrong with the twin? Tell the AI what to fix.'}
          </div>
          {problem && (
            <div className="twin-revise-problem">
              <span>The viewer reported a problem with the program.</span>
              <Button type="link" size="small" onClick={quoteProblem}>
                Quote it in the note
              </Button>
            </div>
          )}
          <Input.TextArea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoSize={{ minRows: 2, maxRows: 6 }}
            maxLength={NOTE_MAX}
            aria-label="What is wrong with the twin"
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter starts a new line. Never while an input method is composing: the
              // Enter that picks a Chinese or Japanese candidate must not send (Safari reports that Enter
              // with isComposing false but keyCode 229).
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
                e.preventDefault();
                send();
              }
            }}
          />
          {/* Only what the owner cannot see for themselves: how close the note is to the cap, and that a
              build is in the way. Enter sends and Shift+Enter starts a new line, unsaid (the owner's call). */}
          {(draft.length > NOTE_MAX * 0.8 || (running && !pending)) && (
            <div className="twin-revise-hint">
              {draft.length > NOTE_MAX * 0.8 ? `${draft.length} / ${NOTE_MAX}` : 'Wait for the build to finish'}
            </div>
          )}
          {/* Which AI model gets the note — the one that made the twin as it stands unless the owner picks
              another. Laid out like the build form's row. */}
          <div className="twin-compose-row">
            <label className="twin-compose-model">
              <span>AI model</span>
              <Select<TwinModelKey>
                size="small"
                value={model}
                onChange={setPicked}
                disabled={running}
                popupMatchSelectWidth={false}
                aria-label="AI model that revises the twin"
                options={TWIN_MODELS[kind].map((k) => ({ value: k, label: TWIN_MODEL_LABELS[k] }))}
              />
            </label>
            <div className="twin-compose-buttons">
              <Button
                type="primary"
                size="small"
                icon={<SendOutlined />}
                disabled={!draft.trim() || running}
                onClick={send}
                title={reviseTitle(TWIN_MODEL_LABELS[model])}
              >
                Revise
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TwinRevise;

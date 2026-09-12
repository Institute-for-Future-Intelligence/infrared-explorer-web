/**
 * The revision thread of a scene twin (docs/digital-twin-plan.md §19), under the viewer's About: the
 * owner tells the AI what is wrong with the twin — "the roof is flat", "there are eight columns, not
 * six" — and an AI model rewrites the program with the note, the program and the same pictures in front
 * of it; the measured surfaces are then traced again. The owner picks which AI model gets the note (§20),
 * starting from the one that wrote the program as it stands; the request the twin was built to goes with
 * it. Each round stays on the record as the note, the model it went to and that model's account of what
 * it changed, so every reader sees how the twin came to be; only an owner with staff access (who may also
 * Regenerate) gets the box.
 *
 * A revision is a twinRun.ts run like a build — one per experiment at a time, surviving a tab switch,
 * stoppable — flagged `revision`, so it reports here rather than in the build toolbar. A note that
 * failed or was stopped stays in the thread, marked as not applied, until it is sent again or dismissed.
 *
 * The dialog belongs to the Realistic view — the model's shape is what a note is about. The viewer hides
 * About on the thermal views without unmounting it, so a half-written note survives a switch of view.
 */
import { useState } from 'react';
import { Button, Input, Select } from 'antd';
import { LoadingOutlined, SendOutlined } from '@ant-design/icons';
import { Experiment, TwinBuildingRecord } from '../../../types';
import useCommonStore from '../../../stores/common';
import { analyzeTwinBuilding } from '../../../services/ai';
import {
  TWIN_DEFAULT_MODEL,
  TWIN_MODELS,
  TWIN_MODEL_LABELS,
  type TwinModelKey,
  isTwinModelKey,
  twinModelOf,
} from './twinModels';
import { type TwinRun, startTwinRun, stopTwinRun, storeTwinRecord, useTwinRun } from './twinRun';

/** The label of a model a round of the thread went to, when it says (rounds from before §20 do not). */
const labelOf = (key: string | undefined) => (isTwinModelKey(key, 'program') ? TWIN_MODEL_LABELS[key] : null);

/** The server's cap on a note (TWIN_REVISION_NOTE_MAX in functions/src/twinBuilding.ts). */
const NOTE_MAX = 1000;
/** A problem the viewer reported is quoted at most this long: the start of a message says what failed. */
const PROBLEM_QUOTE_MAX = 300;

const when = (at: number) =>
  at > 0
    ? new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';

interface Props {
  record: TwinBuildingRecord;
  experiment: Experiment;
  source: 'photos' | 'orbit';
  /** The owner with staff access — the one who may send a note; everyone else reads the thread. */
  canRevise: boolean;
  /** What the viewer reported about the program as it ran (an error, or an early stop): offered for
   *  quoting in a note, since it is the most exact account there is of what went wrong. */
  problem: string | null;
}

const TwinRevise = ({ record, experiment, source, canRevise, problem }: Props) => {
  const user = useCommonStore((state) => state.user);
  const ownerViewing = !!user && user.id === experiment.ownerId;
  const run = useTwinRun(experiment.id);
  const running = !!run && !run.done;
  const pending = run && !run.done && run.revision ? run : null;
  // The last revision, when it ended without being applied — until the owner sends it again or lets it go.
  const [dismissed, setDismissed] = useState<TwinRun | null>(null);
  const unapplied = run && run.done && run.revision && (run.error || run.stopped) && run !== dismissed ? run : null;
  const [draft, setDraft] = useState('');
  // The AI model the next note goes to: the owner's pick, else the one that wrote the program as it stands
  // (which knows it best), else the usual scene model.
  const [picked, setPicked] = useState<TwinModelKey | null>(null);
  const model: TwinModelKey = picked ?? twinModelOf(record, 'program') ?? TWIN_DEFAULT_MODEL.program;
  const revisions = record.revisions ?? [];
  if (!canRevise && !revisions.length) return null;

  const pictures = `${record.photosSent.length} ${source === 'orbit' ? 'frame' : 'photo'}${record.photosSent.length === 1 ? '' : 's'}`;
  const send = () => {
    const note = draft.trim();
    if (!note || running) return;
    const to = model;
    startTwinRun(
      experiment.id,
      async (set, signal) => {
        set(
          `Sending your note, the program and the ${pictures} to ${TWIN_MODEL_LABELS[to]} — it is rewriting the scene${record.thermal ? ', then the measured surfaces are traced again' : ''}. This takes a minute or two.`,
        );
        storeTwinRecord(experiment.id, await analyzeTwinBuilding(experiment.id, source, { note, model: to }, signal));
      },
      { note, model: to },
    );
    setDraft('');
  };
  const sendAgain = (r: TwinRun) => {
    setDraft(r.revision?.note ?? '');
    const to = r.revision?.model;
    if (isTwinModelKey(to, 'program')) setPicked(to);
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
          {/* Which AI model gets the note — the one that wrote the program as it stands unless the owner
              picks another. Laid out like the build form's row. */}
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
                options={TWIN_MODELS.program.map((k) => ({ value: k, label: TWIN_MODEL_LABELS[k] }))}
              />
            </label>
            <div className="twin-compose-buttons">
              <Button
                type="primary"
                size="small"
                icon={<SendOutlined />}
                disabled={!draft.trim() || running}
                onClick={send}
                title={`${TWIN_MODEL_LABELS[model]} rewrites the twin from your note and the pictures; the measured temperatures are read again`}
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

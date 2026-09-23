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
 * A scene twin's note can be about particular things (§28): the owner clicks them in the viewer — one wall
 * of a block, a roof slab, a round part; a click adds what is under it, a click on a selected thing takes
 * it out (`selection`; the host keeps the selection, and the frame's highlight and hint are the whole
 * account of it — the box shows no list and no tags, §28.4), and the model is told what the note is about,
 * each thing by its part, size and position. And it can carry pictures (`pictures`): files attached or pasted, or the view as
 * the frame draws it (`captureView`), sized for the call by utils/noteImages.ts and sent with the note; the
 * record keeps only the labels and how many pictures went, and the thread shows the count, not the labels
 * (§28.4). A fixed-camera twin's host offers neither.
 *
 * A revision is a twinRun.ts run like a build — one per experiment at a time, surviving a tab switch,
 * stoppable — flagged `revision`, so it reports here rather than in the build toolbar. A note that
 * failed or was stopped stays in the thread, marked as not applied, until it is sent again or dismissed.
 *
 * A scene program's dialog belongs to the Realistic view — the model's shape is what a note is about. The
 * viewer hides About on the thermal views without unmounting it, so a half-written note survives a switch
 * of view.
 */
import { type ClipboardEvent, useRef, useState } from 'react';
import { Button, Input, Select } from 'antd';
import { CameraOutlined, LoadingOutlined, PictureOutlined, SendOutlined } from '@ant-design/icons';
import { Experiment, TwinRevision, TwinSelectionItem } from '../../../types';
import useCommonStore from '../../../stores/common';
import { NOTE_IMAGES_MAX, type TwinNoteImage, readNoteImage } from '../../../utils/noteImages';
import {
  TWIN_DEFAULT_MODEL,
  TWIN_MODELS,
  TWIN_MODEL_LABELS,
  type TwinBuildKind,
  type TwinModelKey,
  isTwinModelKey,
} from './twinModels';
import TwinLiveProgress from './twinLiveProgress';
import { type TwinFeed, type TwinRun, type TwinRunRevision, startTwinRun, stopTwinRun, useTwinRun } from './twinRun';

/** The server's cap on a note (TWIN_REVISION_NOTE_MAX in functions/src/twinBuilding.ts). */
const NOTE_MAX = 1000;
/** A problem the viewer reported is quoted at most this long: the start of a message says what failed. */
const PROBLEM_QUOTE_MAX = 300;
/** The note box's placeholder where the viewer can be clicked (§28.4): how to say what a note is about. */
const SELECT_HINT =
  'Click a wall, a roof or a part in the view to say what the note is about; click it again to unselect.';

const when = (at: number) =>
  at > 0
    ? new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';
const pictures = (n: number) => `${n} picture${n === 1 ? '' : 's'}`;

/** What goes with a note besides its words (§28). */
export interface TwinNoteExtras {
  selection: TwinSelectionItem[];
  images: TwinNoteImage[];
}

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
  /** The host's selection (§28) — whatever the owner clicked in the viewer, empty when nothing. Absent: the
   *  host offers no selecting, a note is about the whole twin, and the box says nothing of clicking. */
  selection?: TwinSelectionItem[];
  /** Whether a note may carry pictures (§28) — attached, pasted, or the view as the frame draws it
   *  (`captureView`, which answers null when there is none to give). */
  pictures?: boolean;
  captureView?: () => Promise<string | null>;
  /** What the Revise button says the chosen model (its label) does with the note. */
  reviseTitle: (model: string) => string;
  /** The revision itself, run as a twinRun.ts task: reports progress through `set`, hands the Function's
   *  streamed chunks to `feed` (§28.5), throws to fail, hands `signal` to whatever it waits on, and stores
   *  the record that comes back. `extras` is the selection and the pictures the note carries (§28) — a
   *  host that offers neither may ignore it. */
  revise: (
    note: string,
    model: TwinModelKey,
    set: (progress: string) => void,
    signal: AbortSignal,
    extras: TwinNoteExtras,
    feed: TwinFeed,
  ) => Promise<void>;
}

const TwinRevise = ({
  experiment,
  revisions,
  kind,
  madeBy,
  canRevise,
  problem = null,
  selection,
  pictures: withPictures = false,
  captureView,
  reviseTitle,
  revise,
}: Props) => {
  const user = useCommonStore((state) => state.user);
  const ownerViewing = !!user && user.id === experiment.ownerId;
  const run = useTwinRun(experiment.id);
  const running = !!run && !run.done;
  const pending = run && !run.done && run.revision ? run : null;
  // The last revision, when it ended without being applied — until the owner sends it again or lets it go.
  const [dismissed, setDismissed] = useState<TwinRun | null>(null);
  const unapplied = run && run.done && run.revision && (run.error || run.stopped) && run !== dismissed ? run : null;
  const [draft, setDraft] = useState('');
  // The pictures going with the next note (§28), and why the last one could not be added.
  const [images, setImages] = useState<TwinNoteImage[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // The AI model the next note goes to: the owner's pick, else the one that made the twin as it stands
  // (which knows it best), else the kind's usual model.
  const [picked, setPicked] = useState<TwinModelKey | null>(null);
  const model: TwinModelKey = picked ?? madeBy ?? TWIN_DEFAULT_MODEL[kind];
  const selectable = !!selection;
  if (!canRevise && !revisions.length) return null;

  const who = ownerViewing ? 'You' : 'Owner';
  /** The label of a model a round of the thread went to, when it says (rounds from before §20 do not). */
  const labelOf = (key: string | undefined) => (isTwinModelKey(key, kind) ? TWIN_MODEL_LABELS[key] : null);
  /** A round's line under its note: who, when, the pictures, the model it went to. What the note was about
   *  (the record's labels) is not listed (§28.4): the owner found it noise. */
  const meta = (r: { at?: number; images?: number; modelKey?: string }, lead = who) =>
    [
      lead,
      r.at ? when(r.at) : '',
      r.images ? `with ${pictures(r.images)}` : '',
      labelOf(r.modelKey) && `to ${labelOf(r.modelKey)}`,
    ]
      .filter(Boolean)
      .join(' · ');
  const send = () => {
    const note = draft.trim();
    if (!note || running) return;
    const to = model;
    const extras: TwinNoteExtras = { selection: selection ?? [], images: withPictures ? images : [] };
    const shown: TwinRunRevision = { note, model: to, images: extras.images.length };
    startTwinRun(experiment.id, (set, signal, feed) => revise(note, to, set, signal, extras, feed), shown);
    setDraft('');
    setImages([]);
    setAttachError(null);
  };
  const sendAgain = (r: TwinRun) => {
    setDraft(r.revision?.note ?? '');
    const to = r.revision?.model;
    if (isTwinModelKey(to, kind)) setPicked(to);
    // The selection and the pictures are gone with the run: select and attach them again.
    setDismissed(r);
  };
  const quoteProblem = () => {
    if (!problem) return;
    const quote = problem.length > PROBLEM_QUOTE_MAX ? `${problem.slice(0, PROBLEM_QUOTE_MAX)}…` : problem;
    setDraft((d) => `${d.trim() ? `${d.trim()}\n\n` : ''}The viewer reported: ${quote}`.slice(0, NOTE_MAX));
  };
  /** Add pictures to the note, as many as still fit; says so when they do not all, or one cannot be read. */
  const addPictures = async (sources: { source: File | Blob | string; name: string }[]) => {
    if (!withPictures || !sources.length) return;
    setAttachError(null);
    const room = NOTE_IMAGES_MAX - images.length;
    if (room <= 0) {
      setAttachError(`At most ${pictures(NOTE_IMAGES_MAX)} go with a note.`);
      return;
    }
    const taken: TwinNoteImage[] = [];
    let unreadable = 0;
    for (const { source, name } of sources.slice(0, room)) {
      try {
        taken.push(await readNoteImage(source, name));
      } catch {
        unreadable++;
      }
    }
    if (taken.length) setImages((cur) => [...cur, ...taken].slice(0, NOTE_IMAGES_MAX));
    if (sources.length > room) setAttachError(`At most ${pictures(NOTE_IMAGES_MAX)} go with a note.`);
    else if (unreadable)
      setAttachError(unreadable === 1 ? 'That picture could not be read.' : 'Some pictures could not be read.');
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (!files.length || !withPictures) return;
    e.preventDefault();
    void addPictures(files.map((f) => ({ source: f, name: f.name })));
  };
  const attachView = async () => {
    if (!captureView || capturing) return;
    setCapturing(true);
    try {
      const url = await captureView();
      if (!url) setAttachError('The view could not be captured.');
      else await addPictures([{ source: url, name: 'this view' }]);
    } finally {
      setCapturing(false);
    }
  };
  return (
    <div className="twin-revise">
      {(revisions.length > 0 || pending || unapplied) && (
        <div className="twin-revise-thread" aria-live="polite">
          {revisions.map((r, i) => (
            <div className="twin-revise-turn" key={`${r.at}-${i}`}>
              <div className="twin-revise-note">{r.feedback}</div>
              <div className="twin-revise-meta">{meta(r)}</div>
              <div className="twin-revise-reply">{r.changes || 'The AI did not say what it changed.'}</div>
            </div>
          ))}
          {pending && (
            <div className="twin-revise-turn">
              <div className="twin-revise-note">{pending.revision!.note}</div>
              {!!pending.revision!.images && (
                <div className="twin-revise-meta">{meta({ ...pending.revision!, modelKey: undefined })}</div>
              )}
              {/* The spinner, with where the Function is and what the model writes once it streams (§28.5),
                  and a word of the run's own only when it has one to say (stopping). */}
              <TwinLiveProgress
                run={pending}
                icon={<LoadingOutlined spin />}
                className="twin-revise-reply twin-revise-live"
              />
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
                {meta({ ...unapplied.revision!, at: 0, modelKey: unapplied.revision!.model }, 'Not applied')}
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
          {/* Where selecting is offered, the only words are the box's placeholder — how to select (§28.4:
              the owner wanted no line above the box); elsewhere, the invitation to say what is wrong. */}
          {!selectable && (
            <div className="twin-revise-lead">
              {revisions.length
                ? 'Anything else wrong with the twin?'
                : 'Something wrong with the twin? Tell the AI what to fix.'}
            </div>
          )}
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
            onPaste={onPaste}
            autoSize={{ minRows: 2, maxRows: 6 }}
            maxLength={NOTE_MAX}
            placeholder={selectable ? SELECT_HINT : undefined}
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
          {/* The pictures going with the note (§28): what is attached so far, and the ways to add one. */}
          {withPictures && (
            <>
              {images.length > 0 && (
                <div className="twin-revise-attachments">
                  {images.map((img, i) => (
                    <div className="twin-revise-thumb" key={`${i}-${img.name}`}>
                      <img src={img.preview} alt={img.name || `picture ${i + 1}`} title={img.name} />
                      <button
                        type="button"
                        aria-label={`Remove ${img.name || `picture ${i + 1}`}`}
                        onClick={() => setImages((cur) => cur.filter((_, k) => k !== i))}
                        disabled={running}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="twin-revise-attach">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(e) => {
                    const files = [...(e.target.files ?? [])];
                    e.target.value = '';
                    void addPictures(files.map((f) => ({ source: f, name: f.name })));
                  }}
                />
                <Button
                  type="link"
                  size="small"
                  icon={<PictureOutlined />}
                  onClick={() => fileRef.current?.click()}
                  disabled={running || images.length >= NOTE_IMAGES_MAX}
                  title="A photo of the real thing, a sketch, a marked-up screenshot — or paste one into the note"
                >
                  Attach a picture
                </Button>
                {captureView && (
                  <Button
                    type="link"
                    size="small"
                    icon={<CameraOutlined />}
                    onClick={() => void attachView()}
                    loading={capturing}
                    disabled={running || images.length >= NOTE_IMAGES_MAX}
                    title="The 3D view as it is on screen now, so the AI sees what you see"
                  >
                    Attach this view
                  </Button>
                )}
                {images.length > 0 && (
                  <span className="twin-revise-hint">
                    {images.length} / {NOTE_IMAGES_MAX}
                  </span>
                )}
                {attachError && <span className="twin-revise-attach-error">{attachError}</span>}
              </div>
            </>
          )}
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

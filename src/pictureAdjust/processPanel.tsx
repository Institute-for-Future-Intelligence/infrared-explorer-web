/**
 * Process — the capture app's panel (its code calls it Adjust) on this site: the picture's eleven sliders,
 * Auto, and its stack of effects, for the view of the picture on screen. Phase 2 of docs/processed-views.md.
 *
 * BESIDE THE PICTURE, NEVER OVER IT — the picture is what is being judged (the app's rule). The player
 * puts the panel where the workspace card is (Info / Charts / Ask AI), which waits behind it: on a desktop
 * that is the column next to the frame, on a phone the block under it, where the app's panel stands.
 *
 * What the app's panel does, laid out for a page instead of a phone's bottom edge — ONE page, the sliders
 * and under them the effects, nothing to switch between (user's call, 2026-11-23; the app has two tabs
 * for want of room):
 *
 *  - The sliders, every one at once, each with its position. Auto, a key at their head, sets Brightness
 *    and Contrast for the picture on screen and leaves the others where they are. A click on a slider's
 *    number puts it back to zero.
 *  - The effects: the picture as the panel opened on it under each, small (made once; they do not follow
 *    the sliders or the frame). A click puts one on at the amount the app's
 *    old filter had; they STACK in the order they were put on, and each wears its place in that order. A
 *    click on one that is on takes it off — the pointer over it shows a cross to say so (user's call,
 *    2026-11-23). Every effect that is on has its own slider under the row, in the stack's order; at zero
 *    it stays in its place, doing nothing, until another effect is put on. None takes them all off.
 *  - Hold the compare key to see the picture as it was made; let go to have the settings back.
 *  - Undo / Redo walk the steps taken since the panel opened on this picture (steps.ts). Reset is a step.
 *  - Done keeps the settings; Cancel keeps nothing. Whose they are once kept is the player's to say, and
 *    to tell the reader (`note`): the owner's go on the experiment, a visitor's stay in their session.
 *
 * The panel owns the settings of ONE picture while it is up and tells the player of every change
 * (`onChange`); the player repaints the frame and holds the latest set. It is mounted again (keyed) when
 * the picture it is on changes — another view, another photo of a set.
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Slider, Tooltip } from 'antd';
import {
  ADJUST_EFFECTS,
  ADJUST_KEYS,
  ADJUST_LABEL,
  ADJUST_RANGE,
  AdjustEffect,
  AdjustKey,
  EFFECT_DEFAULT,
  NO_ADJUST,
  PictureAdjust,
  isAdjusted,
  withEffectAmount,
  withEffects,
  withoutHeldEffects,
} from './core/pictureAdjustParams';
import { EffectPreviews, releasePreviews } from './panelPictures';
import { Steps, canRedo, canUndo, firstStep, withStep } from './steps';

/** The effects' names, as the app's row has them. */
const EFFECT_LABEL: Record<AdjustEffect, string> = {
  invert: 'Invert',
  edge: 'Edge',
  solarize: 'Solarize',
  threshold: 'Threshold',
  blur: 'Blur',
  posterize: 'Posterize',
  sepia: 'Sepia',
  emboss: 'Emboss',
  displace: 'Displace',
  glow: 'Glow',
  weave: 'Weave',
};
const EFFECT_TILES: readonly (AdjustEffect | 'none')[] = ['none', ...ADJUST_EFFECTS];

/** `+12`, `−7`, `0` — a slider's position as it is read. */
const signed = (v: number): string => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0');

export interface ProcessPanelProps {
  /** The settings as the panel opens on the picture: the view's own, or nothing on. */
  initial: PictureAdjust;
  /** Which picture this is, for the panel's heading: "Infrared", "Photo 2 · Visible". */
  subject: string;
  /** A setting changed (a slider, an effect, Auto, Reset, a step back): repaint the picture. */
  onChange: (next: PictureAdjust) => void;
  /** The compare key went down / came up: the picture as made meanwhile. */
  onPeek: (on: boolean) => void;
  /** Auto: Brightness and Contrast for the picture on screen, or null when it cannot be measured. */
  onAuto: () => Promise<Pick<PictureAdjust, 'brightness' | 'contrast'> | null>;
  /**
   * The effects' thumbnails, with `sliders` on — asked for once, as the panel comes up. Null when they
   * cannot be made: the tiles are plain.
   */
  onEffectPreviews: (sliders: PictureAdjust) => Promise<EffectPreviews | null>;
  /** Under the keys: whose the settings are once Done keeps them. */
  note: string;
  /** Done is being saved: the panel waits. */
  saving?: boolean;
  onCancel: () => void;
  onDone: () => void;
}

const CompareIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <rect x="4" y="4" width="16" height="16" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <path d="M12 4v16h5.5a2.5 2.5 0 0 0 2.5-2.5v-11A2.5 2.5 0 0 0 17.5 4z" fill="currentColor" />
  </svg>
);
const UndoIcon = ({ flip }: { flip?: boolean }) => (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    aria-hidden="true"
    style={flip ? { transform: 'scaleX(-1)' } : undefined}
  >
    <path
      d="M8.5 5 4 9.5 8.5 14M4.5 9.5H14a5.5 5.5 0 0 1 0 11H9"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const AutoIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <path
      d="M5 20 15.5 9.5l-1-1L4 19z"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
    <path
      d="M17 3.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8zM20 11.5l.5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5z"
      fill="currentColor"
    />
  </svg>
);
/** Over an effect that is on, under the pointer: a click takes it off. */
const RemoveIcon = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
    <path
      d="M6.5 6.5l11 11M17.5 6.5l-11 11"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
    />
  </svg>
);

const ProcessPanel = ({
  initial,
  subject,
  onChange,
  onPeek,
  onAuto,
  onEffectPreviews,
  note,
  saving = false,
  onCancel,
  onDone,
}: ProcessPanelProps) => {
  const [value, setValue] = useState<PictureAdjust>(initial);
  // Read by handlers that run between renders (a drag's moves, its release).
  const valueRef = useRef(value);
  const [steps, setSteps] = useState<Steps>(() => firstStep(initial));
  const stepsRef = useRef(steps);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  /** Put `next` on the panel and the picture. Not a step yet: a drag shows many. */
  const show = (next: PictureAdjust) => {
    valueRef.current = next;
    setValue(next);
    onChangeRef.current(next);
  };
  const putSteps = (next: Steps) => {
    stepsRef.current = next;
    setSteps(next);
  };
  /** Where the settings stand now becomes a step (unless it is the one they are on). */
  const commit = () => putSteps(withStep(stepsRef.current, valueRef.current));
  /** A whole change at once (Auto, an effect, Reset): shown and counted. */
  const put = (next: PictureAdjust) => {
    show(next);
    commit();
  };
  const stepTo = (to: number) => {
    const { list, at } = stepsRef.current;
    if (to < 0 || to >= list.length || to === at) return;
    putSteps({ list, at: to });
    show(list[to]);
  };
  const undo = () => {
    // (A move still under the pointer is a step of its own first.)
    commit();
    stepTo(stepsRef.current.at - 1);
  };
  const redo = () => {
    commit();
    stepTo(stepsRef.current.at + 1);
  };

  // Hold-to-compare. Let go anywhere (the pointer may have left the key), and when the panel goes.
  const [peeking, setPeeking] = useState(false);
  const peekingRef = useRef(false);
  const onPeekRef = useRef(onPeek);
  onPeekRef.current = onPeek;
  const peek = (on: boolean) => {
    if (peekingRef.current === on) return;
    peekingRef.current = on;
    setPeeking(on);
    onPeekRef.current(on);
  };
  useEffect(() => {
    const up = () => peek(false);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('blur', up);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', up);
      up();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto answers later (the player reads the picture's pixels): an answer that arrives after the panel has
  // gone, or after another Auto, is dropped.
  const autoSeqRef = useRef(0);
  useEffect(
    () => () => {
      autoSeqRef.current = -1;
    },
    [],
  );
  const auto = () => {
    const seq = ++autoSeqRef.current;
    onAuto()
      .then((picked) => {
        if (autoSeqRef.current !== seq || picked == null) return;
        put({ ...valueRef.current, brightness: picked.brightness, contrast: picked.contrast });
      })
      .catch(() => {});
  };

  // The effects' thumbnails: made ONCE, when the panel comes up, of the picture as it stood then (its
  // sliders on, each effect alone). They say what each effect is; they do not follow the picture — not the
  // sliders, not the frame (user's call, 2026-11-23: a row that redrew itself under every move was noise).
  // The panel is mounted again for another view or another photo, and makes that picture's then.
  const [previews, setPreviews] = useState<EffectPreviews | null>(null);
  const previewsRef = useRef<EffectPreviews | null>(null);
  const onEffectPreviewsRef = useRef(onEffectPreviews);
  onEffectPreviewsRef.current = onEffectPreviews;
  useEffect(() => {
    let alive = true;
    onEffectPreviewsRef
      .current(withEffects(valueRef.current, null))
      .then((made) => {
        if (!alive) {
          releasePreviews(made);
        } else if (made) {
          previewsRef.current = made;
          setPreviews(made);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
      releasePreviews(previewsRef.current);
      previewsRef.current = null;
    };
  }, []);

  const changed = isAdjusted(value);
  const undoable = canUndo(steps, value);
  const redoable = canRedo(steps, value);
  const stack = value.effects ?? [];

  /** An effect's thumbnail was clicked (see the header). */
  const onTile = (k: AdjustEffect | 'none') => {
    const now = valueRef.current;
    if (k === 'none') {
      put(withEffects(now, null));
    } else if ((now.effects ?? []).some((step) => step.effect === k)) {
      // On (or held at zero): off, and its slider with it.
      put(withEffectAmount(now, k, 0));
    } else {
      // On, at the amount it comes on at — last, over what is there. One held at zero is let go now.
      revealFxRef.current = true;
      put(withEffectAmount(withoutHeldEffects(now), k, EFFECT_DEFAULT[k]));
    }
  };
  // An effect put on brings its slider into sight: on a short page it is under the tiles, past the end of
  // what shows, and the click would seem to have given nothing to set (user's call, 2026-11-23). Only as
  // far as it takes (`nearest`): nothing moves where the slider already shows.
  const revealFxRef = useRef(false);
  const lastFxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!revealFxRef.current) return;
    revealFxRef.current = false;
    lastFxRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [value.effects]);
  // A drag of an effect's slider is worked out from where the stack stood when it began: an effect taken
  // to zero and back up in one drag keeps its place in the order instead of going to the top.
  const fxDragFromRef = useRef<PictureAdjust | null>(null);
  const onFxSlide = (k: AdjustEffect, v: number) => {
    if (fxDragFromRef.current == null) fxDragFromRef.current = valueRef.current;
    // (At zero it is held, not taken out.)
    show(withEffectAmount(fxDragFromRef.current, k, v, true));
  };
  const onFxRelease = () => {
    fxDragFromRef.current = null;
    commit();
  };

  return (
    <div className={saving ? 'process-panel saving' : 'process-panel'} aria-busy={saving}>
      <div className="process-head">
        <div className="process-title">
          Process <span className="process-subject">{subject}</span>
        </div>
        <span className="process-spacer" />
        <Tooltip title="Hold to see the picture as it was made">
          <button
            type="button"
            className={peeking ? 'process-key held' : 'process-key'}
            aria-label="Hold to see the picture as it was made"
            aria-pressed={peeking}
            disabled={!changed && !peeking}
            onPointerDown={(e) => {
              e.preventDefault();
              peek(true);
            }}
            onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && peek(true)}
            onKeyUp={() => peek(false)}
            onBlur={() => peek(false)}
          >
            <CompareIcon />
          </button>
        </Tooltip>
        <Tooltip title="Undo">
          <button type="button" className="process-key" aria-label="Undo" disabled={!undoable} onClick={undo}>
            <UndoIcon />
          </button>
        </Tooltip>
        <Tooltip title="Redo">
          <button type="button" className="process-key" aria-label="Redo" disabled={!redoable} onClick={redo}>
            <UndoIcon flip />
          </button>
        </Tooltip>
        <button type="button" className="process-reset" disabled={!changed} onClick={() => put({ ...NO_ADJUST })}>
          Reset
        </button>
      </div>

      <div className="process-body">
        <div className="process-section">
          <span className="process-section-name">Adjust</span>
          <button type="button" className="process-auto" onClick={auto}>
            <AutoIcon />
            Auto
          </button>
        </div>
        {ADJUST_KEYS.map((k: AdjustKey) => {
          const range = ADJUST_RANGE[k];
          const moved = value[k] !== 0;
          return (
            <div key={k} className={moved ? 'process-slider moved' : 'process-slider'}>
              <span className="process-slider-name">{ADJUST_LABEL[k]}</span>
              <Slider
                className="process-slider-bar"
                min={range.min}
                max={range.max}
                value={value[k]}
                // The sliders that go both ways have no filled side: "no change" is their middle.
                included={range.min === 0}
                tooltip={{ open: false }}
                onChange={(v) => show({ ...valueRef.current, [k]: v })}
                // Released: the whole move is one step.
                onChangeComplete={commit}
              />
              <Tooltip title={moved ? 'Back to 0' : ''}>
                <button
                  type="button"
                  className="process-slider-value"
                  aria-label={`${ADJUST_LABEL[k]} ${signed(value[k])}${moved ? ' — click to put back to 0' : ''}`}
                  disabled={!moved}
                  onClick={() => put({ ...valueRef.current, [k]: 0 })}
                >
                  {signed(value[k])}
                </button>
              </Tooltip>
            </div>
          );
        })}

        <div className="process-section effects">
          <span className="process-section-name">Effects</span>
          <span className="process-hint">Click to add; they stack in the order added. Click again to remove.</span>
        </div>
        {/* The picture on screen under each effect. One that is on is framed and wears its place in the
            stack; under the pointer it shows a cross — a click takes it off. Before the thumbnails are
            made (and where they cannot be) the tiles are plain, and work the same. */}
        <div className="process-tiles">
          {EFFECT_TILES.map((k) => {
            const place = k === 'none' ? -1 : stack.findIndex((step) => step.effect === k);
            const on = k === 'none' ? stack.length === 0 : place >= 0;
            const url = previews?.[k];
            const name = k === 'none' ? 'None' : EFFECT_LABEL[k];
            return (
              <button
                key={k}
                type="button"
                className={`process-tile${on ? ' on' : ''}${place >= 0 ? ' removable' : ''}`}
                aria-pressed={on}
                aria-label={place >= 0 ? `${name} — on; click to remove` : name}
                onClick={() => onTile(k)}
              >
                <span className="process-thumb">
                  {url ? <img src={url} alt="" draggable={false} /> : null}
                  {place >= 0 && (
                    <>
                      <span className="process-remove">
                        <RemoveIcon />
                      </span>
                      <span className="process-place">{place + 1}</span>
                    </>
                  )}
                </span>
                <span className="process-tile-name">{name}</span>
              </button>
            );
          })}
        </div>

        {/* Each effect that is on, in the stack's order: how much of it. */}
        {stack.map((step, i) => (
          <div key={step.effect} ref={i === stack.length - 1 ? lastFxRef : undefined} className="process-slider moved">
            <span className="process-slider-name">
              <span className="process-place inline">{i + 1}</span>
              {EFFECT_LABEL[step.effect]}
            </span>
            <Slider
              className="process-slider-bar"
              min={0}
              max={100}
              value={step.amount}
              tooltip={{ open: false }}
              onChange={(v) => onFxSlide(step.effect, v)}
              onChangeComplete={onFxRelease}
            />
            <span className="process-slider-value">{step.amount}</span>
          </div>
        ))}
      </div>

      <div className="process-foot">
        <p className="process-note">{note}</p>
        <Button onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="primary" onClick={onDone} loading={saving}>
          Done
        </Button>
      </div>
    </div>
  );
};

export default ProcessPanel;

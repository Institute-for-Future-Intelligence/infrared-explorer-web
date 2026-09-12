/**
 * The owner's build form for a 3D twin (docs/digital-twin-plan.md §20): what they want from the AI —
 * what the subject is, what to leave out, facts the pictures cannot show — and which AI model builds it.
 * Before there is a twin it IS the empty state (the `card` layout, with what a build does above it); once
 * there is one, Regenerate opens it in place of the toolbar (`inline`), started from the request the twin
 * on screen was built to and the model that built it. The request is optional: the button builds without
 * one. Enter builds once something is written, Shift+Enter starts a new line — except when the build
 * would throw something away (a revision thread, the other kind of twin): then only the button builds.
 *
 * Everything the owner puts in the form is drafted per experiment (twinModels.ts), so a tab switch, a
 * reload or a build that failed brings it back as it was left; the run that stores a twin clears the
 * draft, the record then carrying what was sent. The model chosen is also remembered per kind of twin,
 * as the starting point of the next experiment's form.
 */
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Button, type GetRef, Input, Select, Tooltip } from 'antd';
import { ExclamationCircleOutlined, ThunderboltOutlined } from '@ant-design/icons';
import {
  TWIN_INSTRUCTIONS_MAX,
  TWIN_MODELS,
  TWIN_MODEL_LABELS,
  TWIN_SURFACE_MODEL_LABEL,
  type TwinBuildDraft,
  type TwinBuildKind,
  type TwinModelKey,
  readTwinBuildDraft,
  saveTwinModel,
  savedTwinModel,
  twinModelOf,
  updateTwinBuildDraft,
} from './twinModels';

export interface TwinBuildRequest {
  model: TwinModelKey;
  /** Trimmed; '' when the owner asked for nothing in particular. */
  instructions: string;
}

interface Props {
  expId: string;
  /** Which kind of twin the build makes, and so which models are offered. */
  kind: TwinBuildKind;
  /** The twin a regeneration replaces, when it is of this kind: its model is preselected. Null for a
   *  first build, or a rebuild as the other kind (which starts from that kind's usual model). */
  from: { model: string; modelKey?: string } | null;
  /** The request the twin on screen was built to, whichever kind it is — it is about the subject, which a
   *  rebuild the other way still shows: the box starts from it until the owner edits it. */
  request?: string;
  layout: 'card' | 'inline';
  /** The card's heading. */
  title?: string;
  /** Above the request: a recording's Fixed camera / Walk-around choice. */
  header?: ReactNode;
  /** What a build does, before there is a twin. */
  lead?: ReactNode;
  submitLabel: string;
  /** What the build throws away (a revision thread, another kind of twin), said above the button. */
  warning?: string | null;
  /** Whether this form's build is the one running: its button spins and Stop sits beside it. */
  building: boolean;
  disabled: boolean;
  /** Why the button is disabled, when that is not self-evident (a recording without photos). */
  disabledReason?: string | null;
  /** The pictures carry temperatures, which a second model traces whichever model builds the scene. */
  traced?: boolean;
  onBuild: (request: TwinBuildRequest) => void;
  onStop?: () => void;
  /** A regeneration's form closes without building. */
  onCancel?: () => void;
}

/** Enter (without Shift) — never while an input method is composing: the Enter that picks a Chinese or
 *  Japanese candidate must not build (Safari reports it with isComposing false but keyCode 229). */
const isSubmitKey = (e: KeyboardEvent) =>
  e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229;

const TwinBuildCompose = ({
  expId,
  kind,
  from,
  request,
  layout,
  title,
  header,
  lead,
  submitLabel,
  warning,
  building,
  disabled,
  disabledReason,
  traced,
  onBuild,
  onStop,
  onCancel,
}: Props) => {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<GetRef<typeof Input.TextArea>>(null);
  const [draft, setDraft] = useState<TwinBuildDraft>(() => readTwinBuildDraft(expId));
  // Until the owner edits it, the box follows the request of the twin it starts from.
  const text = draft.text ?? request ?? '';
  // The owner's pick for this kind in this experiment's form, else the model of the twin it replaces, else
  // the last model chosen for this kind anywhere. A recording can switch kinds under the form, and each
  // kind keeps its own pick.
  const model = draft.models?.[kind] ?? twinModelOf(from, kind) ?? savedTwinModel(kind);
  const busy = disabled || building;
  // Enter builds only when nothing is thrown away: a rebuild that replaces revisions or the other kind of
  // twin takes the button, whose warning sits right above it.
  const enterBuilds = !warning;

  // Opened from Regenerate at the foot of a long column: bring it into view with the cursor at the end of
  // the request it starts from. Measured two frames on, once the box has sized itself to that request,
  // and never scrolled so far that the form's head leaves view. On a desktop the COLUMN scrolls, never the
  // page; on a phone the column is as tall as its content and the page is what scrolls.
  useEffect(() => {
    if (layout !== 'inline') return;
    boxRef.current?.focus({ preventScroll: true, cursor: 'end' });
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        // A request longer than the box: show its end, where the cursor is — inside the box only.
        const box = boxRef.current?.resizableTextArea?.textArea;
        if (box) box.scrollTop = box.scrollHeight;
        const root = rootRef.current;
        if (!root) return;
        const form = root.getBoundingClientRect();
        const scroller = root.closest<HTMLElement>('.twin-side-scroll');
        if (scroller && scroller.scrollHeight > scroller.clientHeight + 1) {
          const column = scroller.getBoundingClientRect();
          const by = Math.min(form.bottom - column.bottom + 12, form.top - column.top);
          if (by > 0) scroller.scrollTop += by;
        } else {
          const by = Math.min(form.bottom - window.innerHeight + 12, form.top);
          if (by > 0) window.scrollBy(0, by);
        }
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [layout]);

  const edit = (value: string) => {
    setDraft((d) => ({ ...d, text: value }));
    updateTwinBuildDraft(expId, { text: value });
  };
  const choose = (key: TwinModelKey) => {
    setDraft((d) => ({ ...d, models: { ...d.models, [kind]: key } }));
    updateTwinBuildDraft(expId, { models: { [kind]: key } });
    saveTwinModel(kind, key);
  };
  const build = () => {
    if (busy) return;
    onBuild({ model, instructions: text.trim() });
  };

  const buildButton = (
    <Button
      type="primary"
      size="small"
      icon={<ThunderboltOutlined />}
      loading={building}
      disabled={disabled && !building}
      onClick={build}
    >
      {submitLabel}
    </Button>
  );
  // Only what the owner cannot see for themselves: how close the request is to the cap. What Enter does
  // (build, or a new line when a build would throw something away) is left unsaid, the owner's call.
  const keys = text.length > TWIN_INSTRUCTIONS_MAX * 0.8 ? `${text.length} / ${TWIN_INSTRUCTIONS_MAX}` : '';

  return (
    <div ref={rootRef} className={`twin-compose twin-compose-${layout}`}>
      {title && <div className="twin-compose-title">{title}</div>}
      {header}
      {lead && <div className="twin-compose-lead">{lead}</div>}
      <label className="twin-compose-label" htmlFor={id}>
        Tell the AI what you want <span className="twin-muted">· optional</span>
      </label>
      <Input.TextArea
        id={id}
        ref={boxRef}
        value={text}
        onChange={(e) => edit(e.target.value)}
        // No placeholder (the owner's call): the label says what the box is for.
        autoSize={{ minRows: layout === 'card' ? 3 : 2, maxRows: 8 }}
        maxLength={TWIN_INSTRUCTIONS_MAX}
        disabled={building}
        onKeyDown={(e) => {
          if (!enterBuilds || !isSubmitKey(e)) return;
          e.preventDefault();
          if (text.trim()) build();
        }}
      />
      <div className="twin-compose-hint">
        <span>Any language · readers see it with the twin</span>
        {keys && <span>{keys}</span>}
      </div>
      {warning && (
        <div className="twin-note twin-compose-warning">
          <ExclamationCircleOutlined />
          <span>{warning}</span>
        </div>
      )}
      <div className="twin-compose-row">
        <label className="twin-compose-model">
          <span>AI model</span>
          <Select<TwinModelKey>
            size="small"
            value={model}
            onChange={choose}
            disabled={busy}
            popupMatchSelectWidth={false}
            aria-label="AI model that builds the twin"
            options={TWIN_MODELS[kind].map((k) => ({ value: k, label: TWIN_MODEL_LABELS[k] }))}
          />
        </label>
        <div className="twin-compose-buttons">
          {onCancel && !building && (
            <Button size="small" onClick={onCancel}>
              Cancel
            </Button>
          )}
          {disabledReason && disabled && !building ? (
            <Tooltip title={disabledReason}>
              <span>{buildButton}</span>
            </Tooltip>
          ) : (
            buildButton
          )}
          {building && onStop && (
            <Button
              size="small"
              danger
              onClick={onStop}
              title={
                layout === 'card'
                  ? 'Stop building — the AI stops too, and nothing is saved'
                  : 'Stop building — the AI stops too, and the twin is left as it was'
              }
            >
              Stop
            </Button>
          )}
        </div>
      </div>
      {traced && kind === 'program' && (
        <div className="twin-compose-hint">
          <span>
            Whichever AI model writes the scene, {TWIN_SURFACE_MODEL_LABEL} traces the surfaces the camera measured.
          </span>
        </div>
      )}
    </div>
  );
};

/** What a twin was built to, for every reader: a model written to particular instructions must not read
 *  as one that was not. Folded, since the twin itself is what the section is about. */
export const TwinRequestNote = ({ instructions, ownerViewing }: { instructions?: string; ownerViewing: boolean }) =>
  instructions ? (
    <details className="twin-request">
      <summary>Built to {ownerViewing ? 'your' : "the owner's"} request</summary>
      <div className="twin-request-text">{instructions}</div>
    </details>
  ) : null;

export default TwinBuildCompose;

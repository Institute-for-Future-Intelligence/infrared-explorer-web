/**
 * The "Digital Twin" workspace tab for a RECORDING (docs/digital-twin-plan.md §9, §18, §43–§44). A
 * recording's twin is the agent's build (agent/twinAgentRunner.ts, §43.5): an AI model measures the
 * recording — where each thing is, in thermal pixels — writes the scene as a small three.js program
 * from those numbers, scores it against the thermal frame, and saves it with the camera it says the
 * recording was made with; the viewer (TwinBuildingViewer) then paints the scene with whatever frame
 * the player shows. The camera must have stood still: the build checks that first (cameraMotionGate)
 * and a camera that moved gets no twin (§44.1). Owner + staff generate; everyone else sees what the
 * owner built. A build outlives this panel: switching tabs must not cancel a run of minutes, so the
 * runner keeps the build's state in a store and the panel just subscribes while it is mounted.
 *
 * Before there is a twin the owner's view is the build form (twinBuildCompose, §20) — what they want from
 * the model, and which AI model builds it — and while a build runs the card is the build (§28.6). With a
 * twin on screen, "Build again…" opens the same form under About. A twin from before §42 — an object list
 * a solver laid out as props — is no longer drawn: the panel says so and offers the form.
 */
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Popconfirm, Tooltip } from 'antd';
import { ClearOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { getMetadata, ref } from 'firebase/storage';
import { Experiment, TwinBuildingRecord, TwinLegacySceneRecord, isTwinBuildingRecord } from '../../../types';
import useCommonStore from '../../../stores/common';
import { firebaseStorage } from '../../../services/firebase';
import { isStaff } from '../../../utils/staff';
import { clearTwinScene } from '../../../services/ai';
import TwinBuildingViewer, { type TwinConversationContext, TwinDeleteButton } from './twinBuildingViewer';
import TwinAgentThread from './agent/TwinAgentThread';
import { forgetTwinAgent, startTwinAgent, stopTwinAgent, useTwinAgentView } from './agent/twinAgentRunner';
import TwinBuildCompose, { type TwinBuildRequest } from './twinBuildCompose';
import { clearTwinBuildDraft, clearTwinNoteDraft, twinModelLabel } from './twinModels';

interface Props {
  experiment: Experiment;
}

/** What a build does, on the card before there is a twin. */
const LEAD =
  'An AI model measures the recording first — where each thing is, in thermal pixels — then writes the scene from those numbers and checks it against the frame before saving it. The twin is painted with the temperatures the camera measured, frame by frame as the player plays. For a camera that stood still; a build takes a few minutes.';

const TwinPanel = ({ experiment }: Props) => {
  const user = useCommonStore((state) => state.user);
  // Read the record off the store so a finished build (which writes there) shows up without a reload.
  const live = useCommonStore((state) => state.experimentMap.get(experiment.id));
  // One field, two kinds of record: the scene program TwinBuildingViewer shows, or a twin from before §42
  // (an object list the panel used to lay out itself), which is only offered for rebuilding.
  const rawRecord = live?.twinScene ?? experiment.twinScene ?? null;
  const record: TwinBuildingRecord | null = rawRecord && isTwinBuildingRecord(rawRecord) ? rawRecord : null;
  const legacy: TwinLegacySceneRecord | null = rawRecord && !isTwinBuildingRecord(rawRecord) ? rawRecord : null;
  const isOwner = !!user && user.id === experiment.ownerId;
  const canGenerate = isOwner && isStaff(user) && !!experiment.recordingId;

  // Whether the recording carries visible-light photos at all. Only app-captured recordings do; a
  // legacy (telelab) recording or a clone of one has nothing for the vision model to recognise (§44.1).
  // Same probe the player uses for its view toggle (a public metadata read; 404 = legacy). Only the
  // build button and its "cannot be rebuilt" note read it, so a viewer — who only ever sees a twin
  // that already exists — skips the request.
  const [hasVisible, setHasVisible] = useState<boolean | null>(null);
  useEffect(() => {
    setHasVisible(null);
    if (!canGenerate) return;
    if (!experiment.recordingId) {
      setHasVisible(false);
      return;
    }
    let cancelled = false;
    getMetadata(ref(firebaseStorage, `recordings/${experiment.recordingId}/vis_1.jpg`))
      .then(() => !cancelled && setHasVisible(true))
      .catch(() => !cancelled && setHasVisible(false));
    return () => {
      cancelled = true;
    };
  }, [experiment.recordingId, canGenerate]);

  const build = useTwinAgentView(experiment.id);
  const running = build.running;
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  // A legacy twin's Build again… opens the form in place of its toolbar; building (or Cancel) closes it.
  // A scene twin has no Build again (user, 2026-10-29): the owner writes to the AI under About instead.
  const [composing, setComposing] = useState(false);
  useEffect(() => {
    if (running) setComposing(false);
  }, [running]);
  // Before there is a twin, how a build ended appears under the card, which a short workspace scrolls
  // (.twin-start): bring it into view when a build stops or fails. (A running build is the card itself, §28.6.)
  const startRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const start = startRef.current;
    if (start && !running && (build.error || build.stopped)) start.scrollTop = start.scrollHeight;
  }, [running, build.error, build.stopped]);

  const generate = (request: TwinBuildRequest) => {
    setComposing(false);
    void startTwinAgent(experiment, { model: request.model, instructions: request.instructions });
  };
  const stop = () => stopTwinAgent(experiment.id);
  const cancelCompose = () => {
    setComposing(false);
    clearTwinBuildDraft(experiment.id);
  };

  const clear = async () => {
    setClearing(true);
    try {
      await clearTwinScene(experiment.id);
      // A note half-written about the removed twin is not about the next one (§31.7).
      clearTwinNoteDraft(experiment.id);
      // Nor is the conversation that built it (user, 2026-10-30).
      forgetTwinAgent(experiment.id);
      const store = useCommonStore.getState();
      const cur = store.experimentMap.get(experiment.id);
      if (cur) {
        const { twinScene: _dropped, ...rest } = cur;
        store.setExperiment(experiment.id, rest as Experiment);
      }
    } catch (e) {
      setClearError(e instanceof Error ? e.message : String(e));
    } finally {
      setClearing(false);
    }
  };

  // The build as a conversation (TwinAgentThread): the card's content while it builds; under the card once
  // a build has been started in this session; and, with a twin on screen, About's conversation — where the
  // owner also writes what to change (§44.8), about the parts they selected in the view (§44.10).
  const thread = <TwinAgentThread experiment={experiment} hadTwin={!!rawRecord} />;
  const outcome = !running && build.started ? thread : null;
  const conversation = ({ selection, clearSelection }: TwinConversationContext) => (
    <TwinAgentThread
      experiment={experiment}
      hadTwin={!!rawRecord}
      canSend={canGenerate && hasVisible === true && !clearing}
      selection={selection}
      onSent={clearSelection}
    />
  );
  // What a rebuild throws away besides a legacy twin: its revision thread, said beside the button.
  const storedRevisions = legacy?.revisions?.length ?? 0;
  const replaces =
    legacy && storedRevisions
      ? `This replaces the twin and the ${storedRevisions === 1 ? 'revision' : `${storedRevisions} revisions`} made to it.`
      : null;
  const noPhotos = 'This recording has no visible-light photos, so there is nothing to recognise.';
  const compose = (layout: 'card' | 'inline') => (
    <TwinBuildCompose
      expId={experiment.id}
      // Every build writes a scene program (§42); the form preselects the model of the twin it replaces,
      // when that model is offered, and starts from the request it was built to.
      kind="program"
      from={record ?? legacy}
      request={record?.instructions ?? legacy?.instructions}
      layout={layout}
      title={layout === 'card' ? 'Build a digital twin' : undefined}
      lead={layout === 'card' ? LEAD : undefined}
      submitLabel={rawRecord ? 'Build again' : 'Build digital twin'}
      warning={replaces}
      building={running}
      progress={thread}
      // Not while a clear is in flight either: a run started then would be racing the removal.
      disabled={running || clearing || hasVisible !== true}
      disabledReason={
        hasVisible === false
          ? noPhotos
          : hasVisible === null
            ? 'Checking the recording for visible-light photos…'
            : null
      }
      onBuild={generate}
      onStop={stop}
      onCancel={rawRecord ? cancelCompose : undefined}
    />
  );
  const stopButton = running && (
    <Button size="small" danger onClick={stop} title="Stop building — the AI stops too, and the twin is left as it was">
      Stop
    </Button>
  );
  const buildAgainButton = (
    <Button
      size="small"
      icon={<ThunderboltOutlined />}
      onClick={() => setComposing(true)}
      disabled={running || clearing || hasVisible !== true}
      title={
        hasVisible === true ? 'Build a fresh twin — with a new request or another AI model if you like' : undefined
      }
    >
      Build again…
    </Button>
  );
  const buildAgain = hasVisible === false ? <Tooltip title={noPhotos}>{buildAgainButton}</Tooltip> : buildAgainButton;
  // The toolbar of a twin from before §42: Build again… (or the form it opens) / Stop / Clear.
  const legacyControls = (
    <>
      {canGenerate &&
        (composing && !running ? (
          compose('inline')
        ) : (
          <div className="twin-toolbar">
            {buildAgain}
            {stopButton}
            {!running && (
              <Popconfirm
                title="Remove the digital twin?"
                description="Viewers will no longer see it."
                okText="Remove"
                onConfirm={clear}
              >
                <Button size="small" icon={<ClearOutlined />} loading={clearing}>
                  Clear
                </Button>
              </Popconfirm>
            )}
          </div>
        ))}
      {canGenerate && running && thread}
      {outcome}
      {clearError && <Alert type="error" showIcon closable message={clearError} onClose={() => setClearError(null)} />}
    </>
  );
  // Under About's conversation of a scene twin: a running build's Stop, nothing else — a change is asked
  // for in the conversation, and Delete is on About's title row (deleteAction).
  const controls = (
    <>
      {canGenerate && running && <div className="twin-toolbar">{stopButton}</div>}
      {clearError && <Alert type="error" showIcon closable message={clearError} onClose={() => setClearError(null)} />}
    </>
  );
  const deleteAction = canGenerate && !running ? <TwinDeleteButton onConfirm={clear} loading={clearing} /> : null;

  return (
    <div className="twin-panel">
      {/* A twin from before §42: the toolbar — or the build form it opens — then the notice, scrolling
          inside the panel. */}
      {legacy && (
        <div className="twin-notice-stack">
          {legacyControls}
          <Alert
            type="info"
            showIcon
            message="This twin is no longer shown"
            description={`It was made the old way — ${twinModelLabel(legacy)} named the objects in frame ${legacy.recordingIndex ?? '?'} and the app placed stand-in shapes for them. Twins are now drawn by the AI model itself${canGenerate ? ': build it again to have the model draw this setup.' : '; the owner can build it again.'}`}
          />
        </div>
      )}

      {!rawRecord && canGenerate && hasVisible === false && (
        <Alert
          type="info"
          showIcon
          message="This recording cannot be built in 3D"
          description="It has no visible-light photos — only recordings captured with the current app carry them (this one is a legacy recording, or a copy of one). The AI model needs the photo to recognise the apparatus; the thermal frames alone are not enough."
        />
      )}
      {!rawRecord && canGenerate && hasVisible !== false && (
        <div className="twin-start" ref={startRef}>
          {compose('card')}
          {outcome}
          {clearError && (
            <Alert type="error" showIcon closable message={clearError} onClose={() => setClearError(null)} />
          )}
        </div>
      )}
      {!rawRecord && !canGenerate && (
        <div className="twin-empty">
          {isOwner && !isStaff(user)
            ? 'Building digital twins is open to staff accounts only for now.'
            : 'The owner has not built a digital twin of this recording yet.'}
        </div>
      )}

      {record && (
        <TwinBuildingViewer
          record={record}
          experiment={experiment}
          controls={controls}
          deleteAction={deleteAction}
          source="orbit"
          conversation={canGenerate ? conversation : undefined}
        />
      )}
    </div>
  );
};

export default TwinPanel;

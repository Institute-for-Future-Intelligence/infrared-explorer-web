/**
 * The "Digital Twin" workspace tab for a PHOTO SET (docs/digital-twin-plan.md §17–§18): several photos of one
 * subject from different standpoints become a model the vision model wrote as a small three.js program,
 * painted with the temperatures the camera measured where the photos carry them. Owner + staff: send the
 * set to the scene-analysis Function and show the result; everyone else: show what the owner built. This
 * panel is the build form and toolbar and the states in which there is nothing to view; the viewing
 * itself — the sandboxed frame, the view modes, the heat maps, the owner's revision thread — is
 * TwinBuildingViewer, shared with the recording panel's walk-around mode. The model's answer
 * (twinScene, kind 'building') is the only state that persists.
 *
 * Before there is a twin, the owner's view IS the build form (twinBuildCompose, §20): what they want from
 * the model and which AI model builds it. Once there is one, the owner revises it by note or deletes it
 * (About's title row) and builds again.
 */
import { useEffect, useRef, useState } from 'react';
import { Alert, Button } from 'antd';
import { LoadingOutlined } from '@ant-design/icons';
import { Experiment, TwinBuildingRecord, isTwinBuildingRecord } from '../../../types';
import useCommonStore from '../../../stores/common';
import { isStaff } from '../../../utils/staff';
import { analyzeTwinBuilding, clearTwinScene } from '../../../services/ai';
import TwinBuildingViewer, { TwinDeleteButton } from './twinBuildingViewer';
import TwinBuildCompose, { type TwinBuildRequest } from './twinBuildCompose';
import TwinLiveProgress from './twinLiveProgress';
import { clearTwinBuildDraft, clearTwinNoteDraft, twinBuildDraftStamp } from './twinModels';
import {
  SAVED_AFTER_STOP,
  failTwinRun,
  startTwinRun,
  stopTwinRun,
  storeTwinRecord,
  twinBuildStopTitle,
  twinRunStoppable,
  useTwinBuildRun,
} from './twinRun';

interface Props {
  experiment: Experiment;
}

const TwinBuildingPanel = ({ experiment }: Props) => {
  const user = useCommonStore((state) => state.user);
  const live = useCommonStore((state) => state.experimentMap.get(experiment.id));
  const rawRecord = live?.twinScene ?? experiment.twinScene ?? null;
  const record: TwinBuildingRecord | null = rawRecord && isTwinBuildingRecord(rawRecord) ? rawRecord : null;
  const isOwner = !!user && user.id === experiment.ownerId;
  const photoCount = experiment.photoCount ?? 0;
  const canGenerate = isOwner && isStaff(user) && !!experiment.recordingId && photoCount >= 1;
  // Whether any photo carries temperature data (absent flags = every photo does): decides what the
  // progress line promises.
  const hasThermalPhotos = !experiment.photoThermal || experiment.photoThermal.some((t) => t !== false);
  const { running, building, error: runError, stopped, savedAfterStop, dismiss } = useTwinBuildRun(experiment.id);
  const [clearing, setClearing] = useState(false);
  // Before there is a twin, how a build ended appears under the card, which a short workspace scrolls
  // (.twin-start): bring it into view when a build stops or fails. (A running build is the card itself, §28.6.)
  const startRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const start = startRef.current;
    if (start && (runError || stopped)) start.scrollTop = start.scrollHeight;
  }, [runError, stopped]);

  const generate = ({ model, instructions }: TwinBuildRequest) => {
    const draft = twinBuildDraftStamp(experiment.id);
    startTwinRun(experiment.id, async (_set, signal, feed) => {
      // The Function streams where it is and what the model writes (§28.5); the form's spinning button
      // and its Stop say a build is running.
      storeTwinRecord(
        experiment.id,
        await analyzeTwinBuilding(experiment.id, 'photos', { model, instructions }, signal, feed),
      );
      // The twin now carries the request it was built to; the next regeneration starts from that.
      clearTwinBuildDraft(experiment.id, draft);
    });
  };

  const clear = async () => {
    setClearing(true);
    try {
      await clearTwinScene(experiment.id);
      // A note half-written about the deleted twin is not about the next one (§31.7).
      clearTwinNoteDraft(experiment.id);
      const store = useCommonStore.getState();
      const cur = store.experimentMap.get(experiment.id);
      if (cur) {
        const { twinScene: _dropped, twinEdits: _edits, ...rest } = cur;
        store.setExperiment(experiment.id, rest as Experiment);
      }
    } catch (e) {
      failTwinRun(experiment.id, e instanceof Error ? e.message : String(e));
    } finally {
      setClearing(false);
    }
  };

  const stop = () => stopTwinRun(experiment.id);
  // Where the build is and what the model writes (§28.5), behind a spinner: the card's content while it
  // builds (§28.6), or under the toolbar when there is a twin.
  const liveProgress = building ? <TwinLiveProgress run={building} icon={<LoadingOutlined spin />} /> : null;
  // How the last build went: under the card before there is a twin, under the toolbar after.
  const status = (
    <>
      {stopped && (
        <Alert
          type="info"
          showIcon
          closable
          message={record ? 'Stopped — the twin was left as it was.' : 'Stopped — nothing was built.'}
          onClose={dismiss}
        />
      )}
      {savedAfterStop && <Alert type="info" showIcon closable message={SAVED_AFTER_STOP} onClose={dismiss} />}
      {runError && <Alert type="error" showIcon closable message={runError} onClose={dismiss} />}
    </>
  );
  // The build form, shown only while there is no twin: starting over is deleting the twin (About's title
  // row) and building it again — there is no Regenerate (§31.4).
  const compose = (layout: 'card' | 'inline') => (
    <TwinBuildCompose
      expId={experiment.id}
      kind="program"
      from={record}
      request={record?.instructions}
      layout={layout}
      title={layout === 'card' ? 'Build a digital twin' : undefined}
      lead={
        layout === 'card'
          ? `An AI model reads the subject's shape off these photos and writes it as a 3D scene you can orbit${hasThermalPhotos ? ', painted with the temperatures the camera measured' : ''}.`
          : undefined
      }
      submitLabel="Build digital twin"
      building={!!building}
      progress={liveProgress ?? undefined}
      // Not while a clear is in flight either: a run started then would be racing the removal.
      disabled={running || clearing}
      onBuild={generate}
      onStop={stop}
      stopDisabled={!!building && !twinRunStoppable(building)}
      stopTitle={building?.stopping ? 'Stopping…' : undefined}
    />
  );
  // Under About: a build's Stop while one runs, and how it went.
  const controls = (
    <>
      {canGenerate && building && (
        <div className="twin-toolbar">
          <Button
            size="small"
            danger
            onClick={stop}
            disabled={!twinRunStoppable(building)}
            title={twinBuildStopTitle(building)}
          >
            Stop
          </Button>
        </div>
      )}
      {liveProgress}
      {status}
    </>
  );
  const deleteAction = canGenerate && !running ? <TwinDeleteButton onConfirm={clear} loading={clearing} /> : null;

  // With a record the viewer places Delete (About's title row) and the build status itself, or puts them
  // under the notice that there is no scene to show.
  return (
    <div className="twin-panel">
      {!record &&
        (canGenerate ? (
          <div className="twin-start" ref={startRef}>
            {compose('card')}
            {status}
          </div>
        ) : (
          <div className="twin-empty">
            {!isOwner
              ? 'The owner has not built a digital twin of this photo set yet.'
              : !isStaff(user)
                ? 'Building digital twins is open to staff accounts only for now.'
                : 'This photo set has no photos to build a digital twin from.'}
          </div>
        ))}

      {record && (
        <TwinBuildingViewer
          record={record}
          experiment={experiment}
          controls={controls}
          deleteAction={deleteAction}
          source="photos"
        />
      )}
    </div>
  );
};

export default TwinBuildingPanel;

/**
 * The "3D Twin" workspace tab for a PHOTO SET (docs/digital-twin-plan.md §17–§18): several photos of one
 * subject from different standpoints become a model the vision model wrote as a small three.js program,
 * painted with the temperatures the camera measured where the photos carry them. Owner + staff: send the
 * set to the scene-analysis Function and show the result; everyone else: show what the owner built. This
 * panel is the build form and toolbar and the states in which there is nothing to view; the viewing
 * itself — the sandboxed frame, the view modes, the heat maps, the owner's revision thread — is
 * TwinBuildingViewer, shared with the recording panel's walk-around mode. The model's answer
 * (twinScene, kind 'building') is the only state that persists.
 *
 * Before there is a twin, the owner's view IS the build form (twinBuildCompose, §20): what they want from
 * the model and which AI model builds it. Once there is one, Regenerate opens the same form, started from
 * the request and the model the twin on screen was built with.
 */
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Popconfirm } from 'antd';
import { ClearOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { Experiment, TwinBuildingRecord, isTwinBuildingRecord } from '../../../types';
import useCommonStore from '../../../stores/common';
import { isStaff } from '../../../utils/staff';
import { analyzeTwinBuilding, clearTwinScene } from '../../../services/ai';
import TwinBuildingViewer from './twinBuildingViewer';
import TwinBuildCompose, { type TwinBuildRequest } from './twinBuildCompose';
import { TWIN_MODEL_LABELS, clearTwinBuildDraft, twinBuildDraftStamp } from './twinModels';
import { failTwinRun, startTwinRun, stopTwinRun, storeTwinRecord, useTwinBuildRun } from './twinRun';

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
  // A regeneration writes a fresh model, and the thread of revisions that shaped this one goes with it.
  const revisions = record?.revisions?.length ?? 0;

  const { running, building, error: runError, stopped, dismiss } = useTwinBuildRun(experiment.id);
  const [clearing, setClearing] = useState(false);
  // Regenerate opens the build form in place of the toolbar; building (or Cancel) closes it.
  const [composing, setComposing] = useState(false);
  // Before there is a twin, a build's progress and how it ended appear under the form, which a short
  // workspace scrolls (.twin-start): bring them into view when a build starts, stops or fails.
  const startRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const start = startRef.current;
    if (start && (building || runError || stopped)) start.scrollTop = start.scrollHeight;
  }, [building, runError, stopped]);

  const generate = ({ model, instructions }: TwinBuildRequest) => {
    setComposing(false);
    const draft = twinBuildDraftStamp(experiment.id);
    startTwinRun(experiment.id, async (set, signal) => {
      const sent = Math.min(photoCount, 8);
      const photos = `${sent} photo${sent === 1 ? '' : 's'}`;
      set(
        hasThermalPhotos
          ? `Sending ${photos} to ${TWIN_MODEL_LABELS[model]} — it is writing the subject as a 3D scene; the surfaces the camera measured are traced after that…`
          : `Sending ${photos} to ${TWIN_MODEL_LABELS[model]} — it is writing the subject as a 3D scene…`,
      );
      storeTwinRecord(
        experiment.id,
        await analyzeTwinBuilding(experiment.id, 'photos', { model, instructions }, signal),
      );
      // The twin now carries the request it was built to; the next regeneration starts from that.
      clearTwinBuildDraft(experiment.id, draft);
    });
  };
  const cancelCompose = () => {
    setComposing(false);
    clearTwinBuildDraft(experiment.id);
  };

  const clear = async () => {
    setClearing(true);
    try {
      await clearTwinScene(experiment.id);
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
  // How the last build is going or went: under the form before there is a twin, under the toolbar after.
  const status = (
    <>
      {building && <div className="twin-status twin-status-live">{building.progress}</div>}
      {stopped && (
        <Alert
          type="info"
          showIcon
          closable
          message={record ? 'Stopped — the twin was left as it was.' : 'Stopped — nothing was built.'}
          onClose={dismiss}
        />
      )}
      {runError && <Alert type="error" showIcon closable message={runError} onClose={dismiss} />}
    </>
  );
  const compose = (layout: 'card' | 'inline') => (
    <TwinBuildCompose
      expId={experiment.id}
      kind="program"
      from={record}
      request={record?.instructions}
      layout={layout}
      title={layout === 'card' ? 'Build a 3D twin' : undefined}
      lead={
        layout === 'card'
          ? `An AI model reads the subject's shape off these photos and writes it as a 3D scene you can orbit${hasThermalPhotos ? ', painted with the temperatures the camera measured' : ''}.`
          : undefined
      }
      submitLabel={record ? 'Regenerate' : 'Build 3D twin'}
      warning={
        record && revisions
          ? `This replaces the twin and the ${revisions === 1 ? 'revision' : `${revisions} revisions`} made to it.`
          : null
      }
      building={!!building}
      // Not while a clear is in flight either: a run started then would be racing the removal.
      disabled={running || clearing}
      traced={hasThermalPhotos}
      onBuild={generate}
      onStop={stop}
      onCancel={record ? cancelCompose : undefined}
    />
  );
  const controls = (
    <>
      {canGenerate &&
        (composing && !building ? (
          compose('inline')
        ) : (
          <div className="twin-toolbar">
            <Button
              size="small"
              icon={<ThunderboltOutlined />}
              loading={!!building}
              onClick={() => setComposing(true)}
              disabled={running || clearing}
              title="Build a fresh twin — with a new request or another AI model if you like"
            >
              Regenerate…
            </Button>
            {building && (
              <Button
                size="small"
                danger
                onClick={stop}
                title="Stop building — the AI stops too, and the twin is left as it was"
              >
                Stop
              </Button>
            )}
            {!running && (
              <Popconfirm
                title="Remove the 3D twin?"
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
      {status}
    </>
  );

  // With a record the viewer places the toolbar itself: at the foot of the settings column, closing the
  // About section, or under the notice that there is no scene to show.
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
              ? 'The owner has not built a 3D twin of this photo set yet.'
              : !isStaff(user)
                ? 'Building 3D twins is open to staff accounts only for now.'
                : 'This photo set has no photos to build a 3D twin from.'}
          </div>
        ))}

      {record && <TwinBuildingViewer record={record} experiment={experiment} controls={controls} source="photos" />}
    </div>
  );
};

export default TwinBuildingPanel;

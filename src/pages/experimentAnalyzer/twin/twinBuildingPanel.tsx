/**
 * The "3D Twin" workspace tab for a PHOTO SET (docs/digital-twin-plan.md §17): several photos of one
 * building from different standpoints become a massing model the vision model wrote as a small
 * three.js program, shown in a sandboxed frame (twinFrame.ts) with a realistic look or a simulated
 * thermal one. Owner + staff: send the set to the building-analysis Function and show the result;
 * everyone else: show what the owner built. Nothing is computed here beyond passing the program and
 * the chosen view to the frame; the model's answer (twinScene, kind 'building') is the only state
 * that persists.
 */
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Popconfirm, Segmented, Select, Slider } from 'antd';
import { ClearOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { Experiment, TemperatureUnit, TwinBuildingRecord, isTwinBuildingRecord } from '../../../types';
import useCommonStore from '../../../stores/common';
import { isStaff } from '../../../utils/staff';
import { analyzeTwinBuilding, clearTwinScene } from '../../../services/ai';
import { TWIN_FRAME_HTML } from './twinFrame';
import { failTwinRun, startTwinRun, useTwinRun } from './twinRun';

type ViewMode = 'realistic' | 'thermal';

/** What the simulated thermal view is computed for. Temperatures in °C; the sun stands where the
 *  azimuth says, in the building frame (0 = from the front, 90 = from the right). */
interface Scenario {
  tOut: number;
  tIn: number;
  irradiance: number;
  sunAzimuthDeg: number;
  sunElevationDeg: number;
}

type PresetKey = 'winterNight' | 'winterDay' | 'summerDay' | 'summerNight';
const PRESETS: Record<PresetKey, { label: string; hint: string; scenario: Scenario }> = {
  winterNight: {
    label: 'Winter night',
    hint: 'Heated inside, freezing outside, clear sky: glass leaks heat, the roof chills.',
    scenario: { tOut: -5, tIn: 21, irradiance: 0, sunAzimuthDeg: 0, sunElevationDeg: -10 },
  },
  winterDay: {
    label: 'Winter day',
    hint: 'Low sun on one side, heating inside: sunlit walls warm a little, glass still stands out.',
    scenario: { tOut: 2, tIn: 21, irradiance: 500, sunAzimuthDeg: 150, sunElevationDeg: 25 },
  },
  summerDay: {
    label: 'Summer afternoon',
    hint: 'High sun, air-conditioned inside: sunlit walls and the road bake, glass reads cooler.',
    scenario: { tOut: 33, tIn: 24, irradiance: 800, sunAzimuthDeg: 220, sunElevationDeg: 55 },
  },
  summerNight: {
    label: 'Summer night',
    hint: 'Warm air, no sun: everything close to the air, the roof a little below it.',
    scenario: { tOut: 24, tIn: 24, irradiance: 0, sunAzimuthDeg: 0, sunElevationDeg: -10 },
  },
};

/** A record from the current contract carries a program; earlier ones carried a block list the app
 *  no longer draws. */
const hasProgram = (r: TwinBuildingRecord | null): r is TwinBuildingRecord & { code: string } =>
  !!r && typeof r.code === 'string' && r.code.length > 0;

interface Props {
  experiment: Experiment;
}

const TwinBuildingPanel = ({ experiment }: Props) => {
  const user = useCommonStore((state) => state.user);
  const unit = useCommonStore((state) => state.temperatureUnit);
  const live = useCommonStore((state) => state.experimentMap.get(experiment.id));
  const rawRecord = live?.twinScene ?? experiment.twinScene ?? null;
  const record: TwinBuildingRecord | null = rawRecord && isTwinBuildingRecord(rawRecord) ? rawRecord : null;
  const isOwner = !!user && user.id === experiment.ownerId;
  const photoCount = experiment.photoCount ?? 0;
  const canGenerate = isOwner && isStaff(user) && !!experiment.recordingId && photoCount >= 1;

  const run = useTwinRun(experiment.id);
  const running = !!run && !run.done;
  const [, runStarted] = useState(0);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const runError = run?.error && run.error !== dismissedError ? run.error : null;
  const [clearing, setClearing] = useState(false);

  const [mode, setMode] = useState<ViewMode>('realistic');
  const [presetKey, setPresetKey] = useState<PresetKey>('winterNight');
  const [scenario, setScenario] = useState<Scenario>(PRESETS.winterNight.scenario);

  // ---- The frame: an iframe with no origin, spoken to only by postMessage.
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [built, setBuilt] = useState<{ meshes: number } | null>(null);
  const post = (msg: Record<string, unknown>) => frameRef.current?.contentWindow?.postMessage(msg, '*');
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const d = e.data as { type?: string; message?: string; meshes?: number } | null;
      if (!d || typeof d !== 'object') return;
      if (d.type === 'ready') setFrameReady(true);
      else if (d.type === 'built') {
        setBuilt({ meshes: d.meshes ?? 0 });
        setFrameError(null);
      } else if (d.type === 'error') setFrameError(String(d.message ?? 'The program failed.'));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  const code = hasProgram(record) && !record.blocker ? record.code : null;
  const unitKey = unit === TemperatureUnit.fahrenheit ? 'F' : 'C';
  useEffect(() => {
    if (!frameReady || !code) return;
    setBuilt(null);
    setFrameError(null);
    post({ type: 'build', code, mode, scenario, unit: unitKey });
    // The mode and scenario travel with the build; their own effect covers later changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameReady, code]);
  useEffect(() => {
    if (!frameReady || !code) return;
    post({ type: 'mode', mode, scenario, unit: unitKey });
  }, [frameReady, code, mode, scenario, unitKey]);

  const generate = () => {
    setDismissedError(null);
    startTwinRun(experiment.id, async (set) => {
      set(
        `Sending ${Math.min(photoCount, 8)} photo${photoCount === 1 ? '' : 's'} to the vision model — it is writing the building as a 3D scene…`,
      );
      const rec = await analyzeTwinBuilding(experiment.id);
      const store = useCommonStore.getState();
      const cur = store.experimentMap.get(experiment.id);
      if (cur) {
        const { twinEdits: _stale, ...rest } = cur;
        store.setExperiment(experiment.id, { ...rest, twinScene: rec });
      }
    });
    runStarted((n) => n + 1);
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
      setDismissedError(null);
      runStarted((n) => n + 1);
    } finally {
      setClearing(false);
    }
  };

  const controls = (
    <>
      {canGenerate && (
        <div className="twin-toolbar">
          <Button
            type={record ? 'default' : 'primary'}
            size="small"
            icon={<ThunderboltOutlined />}
            loading={running}
            onClick={generate}
            disabled={running}
          >
            {record ? 'Regenerate' : 'Build 3D twin'}
          </Button>
          {record && !running && (
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
      )}
      {running && <div className="twin-status twin-status-live">{run!.progress}</div>}
      {runError && (
        <Alert type="error" showIcon closable message={runError} onClose={() => setDismissedError(runError)} />
      )}
    </>
  );

  const stale = !!record && !hasProgram(record) && !record.blocker;
  const preset = PRESETS[presetKey];
  const setScenarioField = (patch: Partial<Scenario>) => setScenario((s) => ({ ...s, ...patch }));

  return (
    <div className="twin-panel">
      {!code && controls}

      {!record && !running && (
        <div className="twin-empty">
          {canGenerate
            ? 'Build a 3D model of this building from the photos: the vision model reads the massing off the photos and writes it as a scene — the wings, the columns, the glazing, the site — which you can orbit and see as a simulated heat map.'
            : 'The owner has not built a 3D twin of this photo set yet.'}
        </div>
      )}

      {record?.blocker && (
        <Alert
          type="warning"
          showIcon
          message="Not rendered"
          description={`${record.blocker}${record.reason && record.reason !== record.blocker ? ` (${record.reason})` : ''}`}
        />
      )}

      {stale && (
        <Alert
          type="info"
          showIcon
          message="Built with an earlier analysis"
          description={
            canGenerate
              ? 'This twin was made by the earlier block-based analysis, which the app no longer draws. Regenerate to build it as a scene.'
              : 'This twin was made by an earlier analysis the app no longer draws; the owner can rebuild it.'
          }
        />
      )}

      {code && (
        <div className="twin-body">
          <div className="twin-side-top">
            {controls}
            {frameError && (
              <Alert
                type="error"
                showIcon
                message="The model's scene could not be built"
                description={`${frameError}${canGenerate ? ' Regenerate to have the model write it again.' : ''}`}
              />
            )}
            <section className="twin-section">
              <Segmented
                className="twin-view-mode"
                size="small"
                block
                value={mode}
                onChange={(v) => setMode(v as ViewMode)}
                options={[
                  { label: 'Realistic', value: 'realistic' },
                  { label: 'Thermal (simulated)', value: 'thermal' },
                ]}
              />
            </section>
          </div>
          <div className="twin-main">
            <div className="twin-canvas">
              <iframe ref={frameRef} sandbox="allow-scripts" srcDoc={TWIN_FRAME_HTML} title="3D twin" />
            </div>
          </div>
          <div className="twin-side-scroll">
            {mode === 'thermal' && (
              <section className="twin-section">
                <div className="twin-section-title">
                  <span>Simulation</span>
                </div>
                <div className="twin-note-muted">
                  A demonstration of what a thermal camera would read under the chosen conditions, from each part&apos;s
                  kind and the way it faces — not a measurement.
                </div>
                <div className="twin-fields">
                  <label className="twin-field">
                    <span>Scenario</span>
                    <Select
                      size="small"
                      value={presetKey}
                      onChange={(k: PresetKey) => {
                        setPresetKey(k);
                        setScenario(PRESETS[k].scenario);
                      }}
                      options={(Object.keys(PRESETS) as PresetKey[]).map((k) => ({
                        value: k,
                        label: PRESETS[k].label,
                      }))}
                    />
                  </label>
                  <div className="twin-note-muted">{preset.hint}</div>
                  <div className="twin-row">
                    <span>Outside</span>
                    <b>{Math.round(scenario.tOut)} °C</b>
                  </div>
                  <Slider
                    className="twin-slider"
                    min={-25}
                    max={45}
                    value={scenario.tOut}
                    onChange={(v) => setScenarioField({ tOut: v })}
                  />
                  <div className="twin-row">
                    <span>Inside</span>
                    <b>{Math.round(scenario.tIn)} °C</b>
                  </div>
                  <Slider
                    className="twin-slider"
                    min={10}
                    max={30}
                    value={scenario.tIn}
                    onChange={(v) => setScenarioField({ tIn: v })}
                  />
                  <div className="twin-row">
                    <span>Sun from</span>
                    <b>
                      {scenario.sunElevationDeg > 0 && scenario.irradiance > 0
                        ? `${Math.round(scenario.sunAzimuthDeg)}° · ${Math.round(scenario.sunElevationDeg)}° up`
                        : 'night'}
                    </b>
                  </div>
                  <Slider
                    className="twin-slider"
                    min={0}
                    max={359}
                    value={scenario.sunAzimuthDeg}
                    disabled={!(scenario.sunElevationDeg > 0 && scenario.irradiance > 0)}
                    onChange={(v) => setScenarioField({ sunAzimuthDeg: v })}
                  />
                </div>
              </section>
            )}
            <section className="twin-section twin-section-last">
              <div className="twin-section-title">
                <span>About</span>
              </div>
              <div className="twin-object">
                <div className="twin-object-head">
                  <span className="twin-object-name">{record!.name}</span>
                  <span className="twin-muted">
                    {built ? `${built.meshes} parts · ` : ''}
                    {Math.round((record!.confidence ?? 0) * 100)}% confident
                  </span>
                </div>
                {record!.description ? <div className="twin-object-desc">{record!.description}</div> : null}
              </div>
              <div className="twin-note-muted">
                Written as a scene by {record!.model} from {record!.photosSent.length} photo
                {record!.photosSent.length === 1 ? '' : 's'}; proportions are the model&apos;s estimate.
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
};

export default TwinBuildingPanel;

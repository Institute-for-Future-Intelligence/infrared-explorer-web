import { Select } from 'antd';
import useCommonStore from '../../../stores/common';
import { updateExperimentPalette } from '../../../services/experiments';
import { Experiment } from '../../../types';
import { PALETTE_KEYS, paletteGradientCss } from '../../../utils/palette';
import { isStaff } from '../../../utils/staff';

interface Props {
  experiment: Experiment;
}

// Friendly labels for the FLIR palette keys (the on-device display names).
const PALETTE_LABELS: Record<string, string> = {
  iron: 'Iron',
  rainbow: 'Rainbow',
  rainhc: 'Rainbow HC',
  contrast: 'Contrast',
  arctic: 'Arctic',
  lava: 'Lava',
  colorwheel6: 'Color wheel',
  whitehot: 'White hot',
  blackhot: 'Black hot',
  coldest: 'Coldest',
  hottest: 'Hottest',
};

// A gradient swatch + name, so the tagger can eyeball which palette matches the frame.
const paletteOption = (key: string) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, lineHeight: 1 }}>
    <span
      aria-hidden
      style={{
        width: 34,
        height: 10,
        borderRadius: 2,
        background: paletteGradientCss(key) ?? undefined,
        boxShadow: '0 0 0 1px rgba(0,0,0,0.2)',
      }}
    />
    {PALETTE_LABELS[key] ?? key}
  </span>
);

/**
 * The experiment's colour palette — which FLIR palette the baked frames were rendered with, so the
 * scale-bar overlay can draw the exact colour↔temperature ramp. Only shown to the owner or staff (it's a
 * technical tag, not viewer-facing); a picker to set it manually when it isn't stored/detected, e.g. for
 * legacy telelab showcases (owned by 'system', so only staff can tag them). Clearing it falls back to
 * auto-detection / an approximate ramp. Renders its own <dt>/<dd> row, or nothing when not editable.
 */
const ExperimentPalette = ({ experiment }: Props) => {
  const user = useCommonStore((state) => state.user);
  const editable = !!user && (user.id === experiment.ownerId || isStaff(user));
  if (!editable) return null;

  const persist = (next: string | null) => {
    updateExperimentPalette(experiment.id, next).catch((e) => console.error('failed to update palette', e));
    const exp = useCommonStore.getState().experimentMap.get(experiment.id);
    if (exp) {
      useCommonStore.getState().setExperiment(experiment.id, {
        ...exp,
        palette: next ?? undefined,
        paletteSource: next ? 'manual' : undefined,
      });
    }
  };

  return (
    <>
      <dt>Palette</dt>
      <dd>
        <Select
          size="small"
          value={experiment.palette ?? undefined}
          placeholder="Auto"
          allowClear
          onChange={(v) => persist(v ?? null)}
          popupMatchSelectWidth={false}
          aria-label="Colour palette"
          style={{ minWidth: 150 }}
          options={PALETTE_KEYS.map((k) => ({ value: k, label: paletteOption(k) }))}
        />
      </dd>
    </>
  );
};

export default ExperimentPalette;

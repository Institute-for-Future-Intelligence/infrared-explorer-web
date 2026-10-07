import { useEffect, useRef } from 'react';
import useCommonStore from '../../stores/common';
import { Experiment, TemperatureUnit } from '../../types';
import { useSavedViewWriter } from './useSavedViewWriter';

/**
 * The °C/°F an experiment opens in, and the owner's changes of it — part of the saved view
 * (ExperimentDoc.savedView.unit, see useSavedViewWriter), like the frame and the 3D surface: the unit the
 * owner last read the experiment in is the one everyone reads it in. The toolbar button flips the store's
 * one `temperatureUnit` (every readout, chart and overlay follows it); this hook sets that from the saved
 * unit when the player mounts, and writes each change back. An experiment saved before the unit was part
 * of the view opens in this browser's last choice, as it always did — and the owner's first open of it
 * saves that choice, so from then on it's the same unit for everyone. A non-owner's flip lasts the visit.
 */
export const useTemperatureUnitMemory = (experiment: Experiment) => {
  const write = useSavedViewWriter(experiment);
  const unit = useCommonStore((state) => state.temperatureUnit);
  // The unit last handed to the writer: the saved one, so the mount's own set below writes nothing.
  // Null for a doc without one, so the opening unit IS written (the legacy case above).
  const lastRef = useRef<TemperatureUnit | null>(experiment.savedView?.unit ?? null);

  useEffect(() => {
    const saved = experiment.savedView?.unit;
    if (saved) useCommonStore.getState().setTemperatureUnit(saved);
  }, [experiment.id, experiment.savedView?.unit]);

  useEffect(() => {
    if (unit === lastRef.current) return;
    lastRef.current = unit;
    write({ unit });
  }, [write, unit]);
};

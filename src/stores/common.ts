import { enableMapSet, produce } from 'immer';
import { create } from 'zustand';
import { TComment, Experiment, TemperatureUnit, Thermometer, User } from '../types';

enableMapSet();

interface CommonStoreState {
  setStore: (fn: (state: CommonStoreState) => void) => void;
  user: User | null;
  setUser: (user: User | null) => void;

  // only cache thumbnail for now
  imageCache: Map<string, string | ArrayBuffer>;
  setImageCache: (url: string, res: string | ArrayBuffer) => void;

  showcaseThermalCache: Map<string, ArrayBuffer[]>;
  setShowcaseThermalCache: (id: string, data: ArrayBuffer[]) => void;

  experimentMap: Map<string, Experiment>;
  setExperiment: (id: string, experiment: Experiment) => void;

  thermometerMap: Map<string, Thermometer>;
  setThermometer: (id: string, thermometer: Thermometer) => void;
  updateThermometer: (id: string, fields: Partial<Thermometer>) => void;
  // Add a new thermometer and register its id on the experiment (in-memory; persisted on "Save analysis").
  addThermometer: (expId: string, thermometer: Thermometer) => void;
  // Remove one / all thermometers from an experiment (also clears the selection when affected).
  removeThermometer: (expId: string, id: string) => void;
  removeAllThermometers: (expId: string) => void;

  // The currently selected thermometer (drives selected-colour + context-menu delete). null = none.
  selectedThermometerId: string | null;
  selectThermometer: (id: string | null) => void;

  commentMap: Map<string, TComment>;
  setComment: (id: string, comment: TComment) => void;

  // Clear the per-experiment caches (thermometers + comments) when leaving the analyzer,
  // so a later clip doesn't accumulate another clip's entries.
  clearAnalysisCaches: () => void;

  // Global temperature display unit (raw readings are Celsius; converted at display time).
  temperatureUnit: TemperatureUnit;
  toggleTemperatureUnit: () => void;
}

const useCommonStore = create<CommonStoreState>()((set, get) => {
  const immerSet: CommonStoreState['setStore'] = (fn) => set(produce(fn));

  return {
    setStore: immerSet,
    user: null,
    setUser(user: User | null) {
      immerSet((state) => {
        state.user = user;
      });
    },

    imageCache: new Map(),
    setImageCache(url, res) {
      immerSet((state) => {
        state.imageCache.set(url, res);
      });
    },

    showcaseThermalCache: new Map(),
    setShowcaseThermalCache(id, data) {
      immerSet((state) => {
        state.showcaseThermalCache.set(id, data);
      });
    },

    experimentMap: new Map(),
    setExperiment(id, experiment) {
      immerSet((state) => {
        state.experimentMap.set(id, experiment);
      });
    },
    thermometerMap: new Map(),
    setThermometer(id, thermometer) {
      immerSet((state) => {
        state.thermometerMap.set(id, thermometer);
      });
    },
    updateThermometer(id, fields) {
      immerSet((state) => {
        const t = state.thermometerMap.get(id);
        if (t) state.thermometerMap.set(id, { ...t, ...fields });
      });
    },
    addThermometer(expId, thermometer) {
      immerSet((state) => {
        state.thermometerMap.set(thermometer.id, thermometer);
        const experiment = state.experimentMap.get(expId);
        if (experiment) {
          const ids = experiment.thermometersId ?? [];
          if (!ids.includes(thermometer.id)) {
            state.experimentMap.set(expId, { ...experiment, thermometersId: [...ids, thermometer.id] });
          }
        }
      });
    },
    removeThermometer(expId, id) {
      immerSet((state) => {
        state.thermometerMap.delete(id);
        const experiment = state.experimentMap.get(expId);
        if (experiment) {
          state.experimentMap.set(expId, {
            ...experiment,
            thermometersId: (experiment.thermometersId ?? []).filter((t) => t !== id),
          });
        }
        if (state.selectedThermometerId === id) state.selectedThermometerId = null;
      });
    },
    removeAllThermometers(expId) {
      immerSet((state) => {
        const experiment = state.experimentMap.get(expId);
        (experiment?.thermometersId ?? []).forEach((id) => state.thermometerMap.delete(id));
        if (experiment) {
          state.experimentMap.set(expId, { ...experiment, thermometersId: [] });
        }
        state.selectedThermometerId = null;
      });
    },
    selectedThermometerId: null,
    selectThermometer(id) {
      immerSet((state) => {
        state.selectedThermometerId = id;
      });
    },
    commentMap: new Map(),
    setComment(id, comment) {
      immerSet((state) => {
        state.commentMap.set(id, comment);
      });
    },
    clearAnalysisCaches() {
      immerSet((state) => {
        state.thermometerMap.clear();
        state.commentMap.clear();
      });
    },
    temperatureUnit: TemperatureUnit.celsius,
    toggleTemperatureUnit() {
      immerSet((state) => {
        state.temperatureUnit =
          state.temperatureUnit === TemperatureUnit.celsius ? TemperatureUnit.fahrenheit : TemperatureUnit.celsius;
      });
    },
  };
});

export default useCommonStore;

import { enableMapSet, produce } from 'immer';
import { create } from 'zustand';
import { TComment, Experiment, Thermometer, User } from '../types';

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

  commentMap: Map<string, TComment>;
  setComment: (id: string, comment: TComment) => void;

  // Clear the per-experiment caches (thermometers + comments) when leaving the analyzer,
  // so a later clip doesn't accumulate another clip's entries.
  clearAnalysisCaches: () => void;
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
  };
});

export default useCommonStore;

import { enableMapSet, produce } from 'immer';
import { create } from 'zustand';
import { Experiment, Thermometer, User } from '../types';

enableMapSet();

interface CommonStoreState {
  setStore: (fn: (state: CommonStoreState) => void) => void;
  user: User | null;
  setUser: (user: User | null) => void;

  imageCache: Map<string, string | ArrayBuffer>;
  setImageCache: (url: string, res: string | ArrayBuffer) => void;

  experimentMap: Map<string, Experiment>;
  setExperiment: (id: string, experiment: Experiment) => void;
  thermometerMap: Map<string, Thermometer>;
  setThermometer: (id: string, thermometer: Thermometer) => void;
}

const useCommonStore = create<CommonStoreState>()((set) => {
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
  };
});

export default useCommonStore;

import { useEffect } from 'react';
import { initAuthListener } from '../services/auth';

/** Register the single app-level Firebase auth listener once on mount. */
export const useAuthInit = () => {
  useEffect(() => {
    initAuthListener();
  }, []);
};

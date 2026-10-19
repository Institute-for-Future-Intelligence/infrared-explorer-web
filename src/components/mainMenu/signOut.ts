import { signOutUser } from '../../services/auth';
import useCommonStore from '../../stores/common';

/** The avatar menu's Sign Out: end the Firebase session, then drop the cached user. */
export const signOut = () =>
  signOutUser()
    .then(() => {
      console.debug('user signed out');
      useCommonStore.getState().setUser(null);
    })
    .catch((error) => {
      console.error(error);
    });

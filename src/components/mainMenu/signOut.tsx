import { getAuth, signOut } from 'firebase/auth';
import useCommonStore from '../../stores/common';

const SignOut = () => {
  const handleSignOut = async () => {
    const auth = getAuth();
    signOut(auth)
      .then(() => {
        console.debug('user signed out');
        useCommonStore.getState().setUser(null);
      })
      .catch((error) => {
        console.error(error);
      });
  };

  return <span onClick={handleSignOut}>Sign Out</span>;
};

export default SignOut;

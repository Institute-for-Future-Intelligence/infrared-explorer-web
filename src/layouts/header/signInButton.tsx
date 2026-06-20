import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup } from 'firebase/auth';
import { useEffect } from 'react';
import { User } from '../../types';
import useCommonStore from '../../stores/common';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { firebaseDatabase } from '../../services/firebase';

const SignInButton = () => {
  const auth = getAuth();
  const provider = new GoogleAuthProvider();

  useEffect(() => {
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        const usersRef = collection(firebaseDatabase, 'users');
        const q = query(usersRef, where('email', '==', user.email));

        const querySnapshot = await getDocs(q);
        querySnapshot.forEach((doc) => {
          useCommonStore.getState().setUser({
            id: doc.data().id,
            displayName: user.displayName,
            email: user.email,
            avatar: user.photoURL,
          } as User);
        });
      } else {
        useCommonStore.getState().setUser(null);
      }
    });
  }, [auth]);

  const signIn = async () => {
    signInWithPopup(auth, provider)
      .then((result) => {
        const credential = GoogleAuthProvider.credentialFromResult(result);
        if (!credential) return;
        const user = result.user;
        console.debug('user signed in', user);
      })
      .catch((error) => {
        const errorMessage = error.message;
        console.error(errorMessage);
      });
  };

  return (
    <button className="signInButton" onClick={signIn}>
      Sign In
    </button>
  );
};

export default SignInButton;

import { initializeApp } from 'firebase/app';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { connectStorageEmulator, getStorage } from 'firebase/storage';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

// Initialize Firebase
export const firebaseApp = initializeApp(config);

export const firebaseDatabase = getFirestore(firebaseApp);
export const firebaseStorage = getStorage(firebaseApp);
export const firebaseAuth = getAuth(firebaseApp);
export const firebaseFunctions = getFunctions(firebaseApp, 'us-central1');

// Local development against the Firebase Emulator Suite.
// Opt in with VITE_USE_EMULATORS=true so a plain `npm start` still hits production.
//
// VITE_USE_FUNCTIONS_EMULATOR=true connects ONLY the Functions emulator, leaving Auth/Firestore/
// Storage on production. Use this to iterate on a Cloud Function locally against REAL data: the
// function's Admin SDK reads prod Firestore/Storage via Application Default Credentials
// (`gcloud auth application-default login`), so you don't have to seed the emulator. Run the
// function emulator with `firebase emulators:start --only functions`.
if (import.meta.env.DEV) {
  const useAll = import.meta.env.VITE_USE_EMULATORS === 'true';
  if (useAll) {
    connectAuthEmulator(firebaseAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(firebaseDatabase, '127.0.0.1', 8080);
    connectStorageEmulator(firebaseStorage, '127.0.0.1', 9199);
  }
  if (useAll || import.meta.env.VITE_USE_FUNCTIONS_EMULATOR === 'true') {
    connectFunctionsEmulator(firebaseFunctions, '127.0.0.1', 5001);
  }
}

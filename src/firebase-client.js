import { initializeApp } from 'firebase/app';
import {
  getAuth, initializeAuth, setPersistence, browserLocalPersistence, browserSessionPersistence,
  signInAnonymously, connectAuthEmulator,
} from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';

export function hasFirebaseConfig() {
  return Boolean(
    import.meta.env.VITE_FIREBASE_API_KEY
    && import.meta.env.VITE_FIREBASE_PROJECT_ID
    && import.meta.env.VITE_FIREBASE_APP_ID,
  ) || import.meta.env.VITE_USE_EMULATORS === 'true';
}

export async function connectFirebase() {
  if (!hasFirebaseConfig()) throw new Error('网站尚未连接 Firebase。请按 README 配置项目。');
  const emulator = import.meta.env.VITE_USE_EMULATORS === 'true';
  const app = initializeApp(emulator ? {
    apiKey: 'demo-key',
    authDomain: 'demo-wordsync.firebaseapp.com',
    projectId: 'demo-wordsync',
    appId: '1:123456789:web:demo',
  } : {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  });
  const auth = emulator
    ? initializeAuth(app, { persistence: browserSessionPersistence })
    : getAuth(app);
  const db = getFirestore(app);
  if (emulator) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
  }
  if (!emulator) await setPersistence(auth, browserLocalPersistence);
  const credential = await signInAnonymously(auth);
  return { db, uid: credential.user.uid };
}

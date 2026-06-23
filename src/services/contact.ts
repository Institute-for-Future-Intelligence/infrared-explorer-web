import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { firebaseDatabase } from './firebase';

/** Store a contact-us message (create-only collection; read by the admin via the console). */
export async function submitContact(name: string, email: string, message: string): Promise<void> {
  await addDoc(collection(firebaseDatabase, 'contactMessages'), {
    name,
    email,
    message,
    createdAt: serverTimestamp(),
  });
}

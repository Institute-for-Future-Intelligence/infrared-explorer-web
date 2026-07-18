import { doc, serverTimestamp, updateDoc, writeBatch } from 'firebase/firestore';
import { firebaseDatabase } from './firebase';
import type { User } from '../types';

export interface FeaturedChange {
  id: string;
  featured: boolean;
}

/**
 * Atomically publish a Manage-mode draft in ONE batch, so a page never shows a half-applied edit.
 * Handles every staged change: featured flips, the hero order, and takedowns. Each write stays inside
 * the staff rule's hasOnly whitelist — a featured flip touches `featured` alone, a takedown sets only
 * the takedown flags — so all of them are authorized for any already-public experiment.
 *
 * `heroIds` is null when there's no hero to write (the Community page has no hero board).
 */
export async function publishCuration(
  featuredChanges: FeaturedChange[],
  heroIds: string[] | null,
  takedowns: { id: string; reason: string }[],
  staff: User,
): Promise<void> {
  const batch = writeBatch(firebaseDatabase);
  for (const c of featuredChanges) {
    batch.update(doc(firebaseDatabase, `experiments/${c.id}`), { featured: c.featured });
  }
  if (heroIds) {
    batch.set(doc(firebaseDatabase, 'config/homepage'), { heroIds: heroIds.slice(0, 5) }, { merge: true });
  }
  for (const { id, reason } of takedowns) {
    batch.update(doc(firebaseDatabase, `experiments/${id}`), {
      trash: true,
      trashedByStaff: true,
      takedownReason: reason,
      takedownAt: serverTimestamp(),
      takedownBy: staff.id,
    });
  }
  await batch.commit();
}

/** Undo a staff takedown (staff only). Clears the staff flag so the owner regains normal control. */
export async function restoreExperiment(id: string): Promise<void> {
  await updateDoc(doc(firebaseDatabase, `experiments/${id}`), {
    trash: false,
    trashedByStaff: false,
  });
}

import { doc, serverTimestamp, updateDoc, writeBatch } from 'firebase/firestore';
import { firebaseDatabase } from './firebase';
import type { User } from '../types';

export interface FeaturedChange {
  id: string;
  featured: boolean;
}

/**
 * Atomically publish a Curate-mode draft: every featured flip plus the hero order, in ONE batch, so
 * the homepage never shows a half-applied edit. Each experiment write touches `featured` alone (the
 * staff rule requires hasOnly(['featured'])); config/homepage carries the hero order.
 */
export async function publishCuration(featuredChanges: FeaturedChange[], heroIds: string[]): Promise<void> {
  const batch = writeBatch(firebaseDatabase);
  for (const c of featuredChanges) {
    batch.update(doc(firebaseDatabase, `experiments/${c.id}`), { featured: c.featured });
  }
  batch.set(doc(firebaseDatabase, 'config/homepage'), { heroIds: heroIds.slice(0, 5) }, { merge: true });
  await batch.commit();
}

/**
 * Immediate staff takedown (NOT part of the draft — governance is separate from curation and must
 * apply at once, and can't be undone by a stray Cancel). Sets trash + the staff flag that blocks the
 * owner from restoring it, plus an audit trail (reason / when / who).
 */
export async function takedownExperiment(id: string, reason: string, staff: User): Promise<void> {
  await updateDoc(doc(firebaseDatabase, `experiments/${id}`), {
    trash: true,
    trashedByStaff: true,
    takedownReason: reason,
    takedownAt: serverTimestamp(),
    takedownBy: staff.id,
  });
}

/** Undo a staff takedown (staff only). Clears the staff flag so the owner regains normal control. */
export async function restoreExperiment(id: string): Promise<void> {
  await updateDoc(doc(firebaseDatabase, `experiments/${id}`), {
    trash: false,
    trashedByStaff: false,
  });
}

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
 * Immediate staff takedown (used on the homepage, where governance is separate from the hero draft
 * and applies at once). Sets trash + the staff flag that blocks the owner from restoring it, plus an
 * audit trail (reason / when / who).
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

/**
 * Publish a Community Manage-mode draft in ONE batch: feature the staged cards onto the homepage
 * Showcase and take down the staged ones (with their audit trail), all-or-nothing. Each write touches
 * only the fields the staff governance rule allows (featured alone, or the takedown flag set), so the
 * rule authorizes it for any already-public experiment — not just the staff member's own.
 */
export async function publishCommunityModeration(
  featureIds: string[],
  takedowns: { id: string; reason: string }[],
  staff: User,
): Promise<void> {
  const batch = writeBatch(firebaseDatabase);
  for (const id of featureIds) {
    batch.update(doc(firebaseDatabase, `experiments/${id}`), { featured: true });
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

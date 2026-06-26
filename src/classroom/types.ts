import type { Timestamp } from 'firebase/firestore';
import { ExperimentType } from '../types';

/**
 * Classroom data model (v1). See docs/classroom-design-zh.md.
 *
 * Identity: every `*Uid` is the legacy Mongo ObjectId (= `user.id` = the `mongoId` claim),
 * NOT the Firebase auth.uid. The teacher is whoever created the class (`teacherUid`); there
 * is no global role system. Visibility is two-tier: assignment submissions are teacher+owner
 * only; the showcase is teacher-curated and class-wide.
 */

/** classes/{classId} */
export interface ClassInfo {
  id: string; // Firestore auto id
  name: string;
  classNumber: string; // human-friendly, globally unique (6 digits); entered when joining
  teacherUid: string; // mongoId of the creator
  teacherName: string;
  teacherEmail?: string; // audit only
  joinOpen: boolean; // teacher can close enrollment
  memberCount: number; // denormalized, maintained by a trigger
  createdAt?: Timestamp;
}

/** classes/{classId}/members/{studentUid} — doc id == studentUid */
export interface ClassMember {
  uid: string;
  displayName: string;
  email: string;
  classRole: 'student' | 'ta';
  joinedAt?: Timestamp;
  submissionCount: number; // denormalized, maintained by a trigger
  lastActiveAt?: Timestamp; // updated by a trigger on submit
}

/** classes/{classId}/assignments/{aId} */
export interface Assignment {
  id: string;
  title: string;
  description: string;
  dueAt: Timestamp | null;
  refExpId: string | null; // teacher's reference experiment for this assignment (optional)
  open: boolean; // still accepting submissions
  createdAt?: Timestamp;
}

/** classes/{classId}/assignments/{aId}/submissions/{studentUid} — idempotent (re-submit overwrites) */
export interface Submission {
  studentUid: string; // == doc id
  studentName: string;
  expId: string;
  recordingId: string | null;
  sourceType: ExperimentType | null;
  // denormalized snapshot so galleries read only the class subtree
  title: string;
  thumbnailURL: string;
  duration: number;
  submittedAt?: Timestamp;
}

/** classes/{classId}/assignments/{aId}/grades/{studentUid} — teacher-only */
export interface Grade {
  studentUid: string;
  score: number | null;
  comment?: string;
  gradedAt?: Timestamp;
}

/**
 * classes/{classId}/workspace/{itemId} — a student's private working area for this class.
 * A reference to one of the student's own experiments (a copied material, or one they brought
 * in). Only the student can read/write their own items; the teacher does not see the workspace.
 */
export interface WorkspaceItem {
  id: string;
  studentUid: string; // owner; doc is private to them
  expId: string;
  title: string;
  thumbnailURL: string;
  recordingId: string | null;
  sourceType: ExperimentType | null;
  sourceMaterialId: string | null; // the showcase material it was copied from (null if brought in)
  createdAt?: Timestamp;
}

/** classes/{classId}/showcase/{itemId} — teacher-curated, class-wide */
export interface ShowcaseItem {
  id: string;
  kind: 'material' | 'student-work'; // teacher material vs promoted student work
  ownerUid: string; // teacher (material) or student (student-work)
  ownerName: string;
  expId: string;
  recordingId: string | null;
  sourceType: ExperimentType | null;
  title: string;
  thumbnailURL: string;
  sourceAssignmentId: string | null; // which assignment it was promoted from (null for material)
  pinned: boolean;
  createdAt?: Timestamp;
}

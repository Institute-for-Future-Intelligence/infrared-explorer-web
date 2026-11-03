import { Timestamp } from 'firebase/firestore';

/*
 * Classroom data model — the minimal classroom (2026-11-02, Charles 2026-10-30: a teacher makes a
 * class, hands out its number and password, and reads the reports students hand in; nothing more).
 * The class and member documents are the ones createClass / joinClass have always written; the
 * reports are what the app's `labprojects` functions keep (functions/src/classroom.ts in the app
 * repository), read here through the same callables the app uses.
 *
 * Identity: the teacher is whoever created the class (`teacherUid`, the mongoId claim). A member's
 * `uid` is that too when the account has one, else the Firebase uid (an anonymous student in the
 * app); `authUid` is the Firebase uid either way.
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
  authUid?: string;
  displayName: string;
  email: string;
  classRole: 'student' | 'ta';
  joinedAt?: Timestamp;
  submissionCount: number; // reports handed in (the app's callables count them)
  lastActiveAt?: Timestamp;
}

/** A picture a handed-in report shows, as the class keeps it. */
export interface ClassReportImage {
  id: string;
  kind: 'diagram' | 'look' | 'overview';
  mime: string;
  caption: string;
  url: string;
  at: number;
}

/**
 * classes/{classId}/reports/{projectId} — a project's report as a student handed it in: a copy,
 * so the teacher reads it whatever becomes of the project. Times are ms epochs.
 */
export interface ClassReport {
  projectId: string;
  /** The Firebase uid of the student who handed it in. */
  studentUid: string;
  /** Their member id in the class. */
  studentId: string;
  /** The name they typed when handing it in. */
  studentName: string;
  title: string;
  markdown: string;
  /** When this wording was written. */
  writtenAt: number;
  by: 'ai' | 'user';
  /** What the model that ran the project is called. */
  model: string;
  images: ClassReportImage[];
  submittedAt: number;
  firstSubmittedAt: number;
}

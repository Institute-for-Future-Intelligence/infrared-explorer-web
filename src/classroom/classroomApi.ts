/*
 * Classroom API — the minimal classroom (2026-11-02): a teacher makes a class, hands out its
 * number and password, and reads the reports students hand in. The class itself is this site's
 * (createClass / changeClassPassword callables, the class document under the rules); everything a
 * student does, and the teacher's read of the hand-ins, is the app's `labprojects` codebase
 * (functions/src/classroom.ts in the app repository) — the student may be an anonymous account in
 * the app, which no rule and no callable here admits, so both clients share those callables and
 * one set of enrolment records.
 */

import { collection, deleteDoc, doc, getDoc, getDocs, query, updateDoc, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { firebaseDatabase, firebaseFunctions } from '../services/firebase';
import { callLabProject } from '../labProjects/api';
import { ClassInfo, ClassReport, ClassReportImage } from './types';

const db = firebaseDatabase;

// ---------------------------------------------------------------------------
// This site's callables (createClass / changeClassPassword)
// ---------------------------------------------------------------------------

export async function createClass(name: string, password: string): Promise<{ classId: string; classNumber: string }> {
  const fn = httpsCallable<{ name: string; password: string }, { classId: string; classNumber: string }>(
    firebaseFunctions,
    'createClass',
  );
  return (await fn({ name, password })).data;
}

/** Read the class join password. Rules only allow the class's teacher to read it. */
export async function fetchClassPassword(classId: string): Promise<string | null> {
  const snap = await getDoc(doc(db, `classSecrets/${classId}`));
  return snap.exists() ? ((snap.data()?.password as string | undefined) ?? null) : null;
}

/** Teacher changes the class join password. */
export async function changeClassPassword(classId: string, newPassword: string): Promise<void> {
  const fn = httpsCallable<{ classId: string; newPassword: string }, { ok: boolean }>(
    firebaseFunctions,
    'changeClassPassword',
  );
  await fn({ classId, newPassword });
}

// ---------------------------------------------------------------------------
// Classes (the teacher's, under the rules)
// ---------------------------------------------------------------------------

export async function fetchClass(classId: string): Promise<ClassInfo | null> {
  const snap = await getDoc(doc(db, `classes/${classId}`));
  return snap.exists() ? { ...(snap.data() as ClassInfo), id: snap.id } : null;
}

/** Classes the user teaches (created). */
export async function fetchTaughtClasses(uid: string): Promise<ClassInfo[]> {
  const snap = await getDocs(query(collection(db, 'classes'), where('teacherUid', '==', uid)));
  const list = snap.docs.map((d) => ({ ...(d.data() as ClassInfo), id: d.id }));
  list.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
  return list;
}

export async function setJoinOpen(classId: string, joinOpen: boolean): Promise<void> {
  await updateDoc(doc(db, `classes/${classId}`), { joinOpen });
}

export async function renameClass(classId: string, name: string): Promise<void> {
  await updateDoc(doc(db, `classes/${classId}`), { name });
}

/** Delete a class; the onClassDeleted trigger recursively removes the subtree + secret/number docs. */
export async function deleteClass(classId: string): Promise<void> {
  await deleteDoc(doc(db, `classes/${classId}`));
}

// ---------------------------------------------------------------------------
// The app's classroom callables: the teacher's role flag, a student's
// enrolment and hand-ins, the teacher's read of them
// ---------------------------------------------------------------------------

/** What classroomJoin / classroomMine answer for a class: the document with ms epochs. */
interface EnrolledClassDTO {
  id: string;
  name: string;
  classNumber: string;
  teacherUid: string;
  teacherName: string;
  joinOpen: boolean;
  memberCount: number;
  createdAt: number | null;
}

/** The DTO as the pages use a class: the same ClassInfo the teacher's queries produce, less the Timestamp. */
const classFromDTO = (c: EnrolledClassDTO): ClassInfo => ({
  id: c.id,
  name: c.name ?? '',
  classNumber: c.classNumber ?? '',
  teacherUid: c.teacherUid ?? '',
  teacherName: c.teacherName ?? '',
  joinOpen: c.joinOpen !== false,
  memberCount: c.memberCount ?? 0,
});

/** Whether the user said they teach (users/{mongoId}.role): what shows "My Classes". */
export async function fetchTeacherRole(uid: string): Promise<boolean> {
  try {
    const snap = await getDoc(doc(db, `users/${uid}`));
    return snap.data()?.role === 'teacher';
  } catch {
    return false;
  }
}

export async function setTeacherRole(teacher: boolean): Promise<void> {
  await callLabProject<{ teacher: boolean }>('classroomSetRole', { teacher });
}

/**
 * Enrol by number and password. The messages are the callable's, shown as they come ("No class
 * with that number." / "Incorrect password." / "Too many join attempts…"); `alreadyMember` is
 * not an error.
 */
export async function joinClass(
  classNumber: string,
  password: string,
): Promise<{ classId: string; joined?: boolean; alreadyMember?: boolean; info: ClassInfo }> {
  const r = await callLabProject<{
    classId: string;
    joined?: boolean;
    alreadyMember?: boolean;
    class: EnrolledClassDTO;
  }>('classroomJoin', { classNumber: classNumber.trim(), password });
  return { classId: r.classId, joined: r.joined, alreadyMember: r.alreadyMember, info: classFromDTO(r.class) };
}

/** The classes the account is enrolled in, newest first. */
export async function fetchEnrolledClasses(): Promise<ClassInfo[]> {
  const r = await callLabProject<{ classes: EnrolledClassDTO[] }>('classroomMine', {});
  return (r.classes ?? []).map(classFromDTO);
}

export async function leaveClass(classId: string): Promise<void> {
  await callLabProject<{ ok: boolean }>('classroomLeave', { classId });
}

/**
 * Hand a project's report in to a class under the student's name (required). A second hand-in of
 * the same project replaces the first; `replaced` says which happened.
 */
export async function submitReport(
  classId: string,
  projectId: string,
  studentName: string,
): Promise<{ submittedAt: number; replaced: boolean }> {
  const r = await callLabProject<{ submittedAt: number; replaced?: boolean }>('classroomSubmitReport', {
    classId,
    projectId,
    studentName: studentName.trim(),
  });
  return { submittedAt: r.submittedAt, replaced: !!r.replaced };
}

export async function withdrawReport(classId: string, projectId: string): Promise<void> {
  await callLabProject<{ ok: boolean }>('classroomWithdrawReport', { classId, projectId });
}

/** Where the caller handed a project in: {classId: submittedAt ms}. */
export async function fetchMySubmissions(projectId: string): Promise<Record<string, number>> {
  const r = await callLabProject<{ submissions?: Record<string, number> }>('classroomMySubmissions', { projectId });
  return r.submissions && typeof r.submissions === 'object' ? r.submissions : {};
}

const IMAGE_KINDS: ClassReportImage['kind'][] = ['diagram', 'look', 'overview'];

/** The reports handed in to a class — the teacher's read; newest first as the server sorts them. */
export async function fetchClassReports(classId: string): Promise<ClassReport[]> {
  const r = await callLabProject<{ reports?: Partial<ClassReport>[] }>('classroomReports', { classId });
  return (r.reports ?? []).map((raw) => {
    const submittedAt = typeof raw.submittedAt === 'number' ? raw.submittedAt : 0;
    return {
      projectId: raw.projectId ?? '',
      studentUid: raw.studentUid ?? '',
      studentId: raw.studentId ?? '',
      studentName: raw.studentName ?? '',
      title: raw.title ?? '',
      markdown: raw.markdown ?? '',
      writtenAt: typeof raw.writtenAt === 'number' ? raw.writtenAt : 0,
      by: raw.by === 'user' ? 'user' : 'ai',
      model: raw.model ?? '',
      images: (raw.images ?? [])
        .filter((i) => i && typeof i.id === 'string' && typeof i.url === 'string' && i.url)
        .map((i) => ({
          id: i.id,
          kind: IMAGE_KINDS.includes(i.kind) ? i.kind : 'diagram',
          mime: i.mime || 'image/png',
          caption: i.caption ?? '',
          url: i.url,
          at: typeof i.at === 'number' ? i.at : 0,
        })),
      submittedAt,
      firstSubmittedAt: typeof raw.firstSubmittedAt === 'number' ? raw.firstSubmittedAt : submittedAt,
    };
  });
}

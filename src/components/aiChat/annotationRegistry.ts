// Bridge from the Lab Assistant's tools to the analyzer's annotation overlay (add / edit / list / remove
// callout notes). The <Annotations> component owns the note state AND the owner→Firestore /
// non-owner→local-sandbox persistence, so tools route through the controller it publishes here (same
// pattern as playerRegistry). null when no analyzer is open.
export interface AnnotationInfo {
  id: string;
  note: string;
  x: number;
  y: number;
  time: { start: number; end: number } | null;
}

export interface AnnotationController {
  /** Add a callout note at [0,1] image coords, optionally limited to a time window (seconds). Reuses the
   *  component's owner/sandbox persistence. Resolves to the new id (null if the note was empty / failed). */
  add: (a: { x: number; y: number; note: string; startSec?: number; endSec?: number }) => Promise<string | null>;
  /** Edit an annotation's text / position / time window. Returns false if the id isn't found. */
  update: (
    id: string,
    fields: { note?: string; x?: number; y?: number; startSec?: number; endSec?: number },
  ) => boolean;
  /** Delete an annotation (no confirm — the caller gates it). */
  remove: (id: string) => void;
  /** The current annotations (in render order). */
  list: () => AnnotationInfo[];
}

export const annotationRegistry: { controller: AnnotationController | null } = { controller: null };

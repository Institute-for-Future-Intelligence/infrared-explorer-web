import { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { Experiment } from '../../../types';
import Content from './content';
import styled from 'styled-components';
import dayjs from 'dayjs';
import { Link } from 'react-router-dom';
import useCommonStore from '../../../stores/common';
import { firebaseDatabase } from '../../../services/firebase';
import { authorProfilePath } from '../../../utils/helpers';
import ExperimentSubject from './experimentSubject';
import { SUBJECT_META } from '../../../components/card/subjectMeta';

interface DescriptionProps {
  experiment: Experiment | undefined;
}

// Look up the experiment this one was cloned from, so the facts can show a "Cloned from …" provenance
// link. Returns undefined while loading, null when there's nothing to show — no clonedFrom, or the
// source is unavailable to this viewer (private, or hard-deleted; the Firestore read rules make those
// two cases indistinguishable, both surfacing as a rejected/absent read), so only a resolved source
// ever renders a row. A missing/blank title falls back rather than showing an empty link.
const useClonedFromSource = (clonedFrom: string | undefined) => {
  const [source, setSource] = useState<{ id: string; displayName: string } | null | undefined>(undefined);
  useEffect(() => {
    if (!clonedFrom) {
      setSource(null);
      return;
    }
    let cancelled = false;
    getDoc(doc(firebaseDatabase, `experiments/${clonedFrom}`))
      .then((snap) => {
        if (cancelled) return;
        const data = snap.exists() ? (snap.data() as { displayName?: string }) : null;
        setSource(data ? { id: clonedFrom, displayName: data.displayName?.trim() || 'Untitled experiment' } : null);
      })
      .catch(() => {
        // permission-denied (private to this viewer) or a deleted source — indistinguishable; show nothing.
        if (!cancelled) setSource(null);
      });
    return () => {
      cancelled = true;
    };
  }, [clonedFrom]);
  return source;
};

// The facts as a single inline row: each fact is a muted label + its value, laid out left to right
// (Updated / Published / Author / Cloned from / Subject). Once the owner's sharing controls
// (Visibility / Homepage) moved out to the header's ⋮ settings menu, only these short read-only facts
// remain — few enough to sit on one line rather than in two stacked columns. flex-wrap lets them fall
// to a second line on a narrow / mobile panel instead of overflowing. It's still a real definition
// list (each fact a div wrapping its dt/dd, valid HTML5) so assistive tech reads term/description
// pairs. align-items:center keeps each label level with a taller value (the Subject picker's box).
const FactsRow = styled.dl`
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 28px;
  font-size: 14px;
  line-height: 1.2;

  .fact {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  dt {
    color: var(--ifi-text-tertiary);
    font-weight: 400;
  }
  dd {
    margin: 0;
    color: #262626;
    display: inline-flex;
    align-items: center;
    min-width: 0;
  }
`;

const Description = ({ experiment }: DescriptionProps) => {
  const user = useCommonStore((state) => state.user);
  // Called before the early return to keep hook order stable across an undefined experiment.
  const clonedSource = useClonedFromSource(experiment?.clonedFrom);

  if (!experiment) return null;

  const { id, description, date, ownerId, author, updatedAt, clonedFrom } = experiment;

  // Credit the author when viewing someone else's experiment; the owner already knows it's theirs.
  const showAuthor = !!author && ownerId !== user?.id;
  // Where the author credit links (real owner → profile, seeded showcase → by-author gallery).
  const authorHref = authorProfilePath(ownerId, author);
  const isOwner = ownerId === user?.id;
  // A viewer on a description-less experiment sees no empty box (nor its heading); the owner always gets
  // it (the heading + an invite to write).
  const showDescription = !!description || isOwner;

  // SUBJECT_META has no entry for null / legacy "N/A", so a viewer on an unclassified experiment gets
  // no Subject fact; the owner always does (to add/edit). Mirrors ExperimentSubject's own null-guard so
  // the label never shows without a value.
  const subjectMeta = experiment.subject ? SUBJECT_META[experiment.subject] : undefined;
  const showSubject = isOwner || !!subjectMeta;

  // Last-edit time, shown only on the owner's own experiments (a private "you last changed this on…"
  // cue). Absent on never-edited / legacy docs, so the row only appears when there's a real value.
  const updatedDate = isOwner ? (updatedAt?.toDate?.() ?? null) : null;

  return (
    <div>
      {/* Facts on one inline row — Updated / Published / Author (for a viewer) / Cloned from / Subject
          — then the description below; the rate + share actions live outside this component. The
          owner's sharing controls (Visibility / Homepage) live in the header's ⋮ settings menu. */}
      <FactsRow>
        {updatedDate && (
          <div className="fact">
            <dt>Updated</dt>
            <dd title={dayjs(updatedDate).format('MM/DD/YYYY hh:mm a')}>{dayjs(updatedDate).format('MMM D, YYYY')}</dd>
          </div>
        )}
        <div className="fact">
          <dt>Published</dt>
          <dd title={dayjs(date).format('MM/DD/YYYY hh:mm a')}>{dayjs(date).format('MMM D, YYYY')}</dd>
        </div>
        {/* Author credits whose experiment this is. Only shown on someone else's experiment — the owner
            already knows it's theirs. Real owners link to their profile; seeded-showcase authors
            (ownerId 'system', no profile doc) link to their by-author showcase gallery instead. */}
        {showAuthor && (
          <div className="fact">
            <dt>Author</dt>
            <dd>{authorHref ? <Link to={authorHref}>{author}</Link> : author}</dd>
          </div>
        )}
        {/* Provenance — a clone links back to its source experiment (nothing shown for originals,
            or when the source is private/deleted for this viewer). */}
        {clonedFrom && clonedSource && (
          <div className="fact">
            <dt>Cloned from</dt>
            <dd>
              <Link to={`/experiments/${clonedSource.id}`}>{clonedSource.displayName}</Link>
            </dd>
          </div>
        )}
        {/* The subject tag, editable inline by the owner (badge + pencil), a read-only badge for
            everyone else — the same control that used to sit beside the title. */}
        {showSubject && (
          <div className="fact">
            <dt>Subject</dt>
            <dd>
              <ExperimentSubject experiment={experiment} />
            </dd>
          </div>
        )}
      </FactsRow>

      {showDescription && (
        <div style={{ marginTop: 20 }}>
          {/* Content renders the "Description" heading itself, with the owner's Edit trigger inline on
              the same row (see content.tsx). */}
          <Content key={id} expId={id} value={description} ownerId={ownerId} heading="Description" />
        </div>
      )}
    </div>
  );
};

export default Description;

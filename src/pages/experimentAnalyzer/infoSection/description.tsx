import { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { Experiment, ExperimentType } from '../../../types';
import Content from './content';
import styled from 'styled-components';
import dayjs from 'dayjs';
import { Link } from 'react-router-dom';
import useCommonStore from '../../../stores/common';
import { firebaseDatabase } from '../../../services/firebase';
import { authorProfilePath, formatDuration } from '../../../utils/helpers';
import { VisibilitySelect } from '../../../components/visibilityControl';
import { FeatureToggle } from '../../../components/featureControl';
import { isStaff } from '../../../utils/staff';
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

// The facts as two side-by-side groups: the left group carries the timeline (Updated/Published/
// Duration, or Author for a viewer), the right group the classification + sharing controls
// (Subject/Visibility/Homepage). Two columns when the panel is wide enough; auto-fit drops the empty
// track below ~2×210px so a narrow / mobile panel stacks the groups instead of cramping them.
// align-items:start keeps both groups top-aligned rather than stretching the shorter one.
const MetaColumns = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 4px 32px;
  align-items: start;
`;

// One fact group as a real definition list: a two-column grid pairs each muted label with its value
// (label and value no longer share size/weight, and assistive tech reads it as structured term/
// description pairs instead of one <br>-separated run). align-items:center vertically centres each
// label against taller values — the Subject picker, the Visibility picker, the Homepage toggle.
//
// grid-auto-rows gives every row the SAME height (28px comfortably holds the tallest control, the small
// Select). Because both the left and right groups are this same component, their row tracks match — so
// the Nth row of the left group lines up horizontally with the Nth row of the right group across the
// gap. Values taller than 28px (a wrapped author link) still grow via the `auto` ceiling.
//
// dd is a flex box (centred) rather than a plain block: a block dd lays its control out on the text
// BASELINE, and the Homepage switch / the selects have no text baseline — the browser synthesizes one
// from the widget's bottom edge, riding it a few px high against the label. As a flex item the control's
// box is the dd's height, so grid centring puts it dead level with its dt.
const MetaList = styled.dl`
  margin: 0;
  min-width: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  grid-auto-rows: minmax(28px, auto);
  gap: 6px 12px;
  align-items: center;
  font-size: 14px;
  line-height: 1.2;

  dt {
    color: var(--ifi-text-tertiary);
    font-weight: 400;
  }
  dd {
    margin: 0;
    color: #262626;
    display: flex;
    align-items: center;
    min-width: 0;
  }
`;

const Description = ({ experiment }: DescriptionProps) => {
  const user = useCommonStore((state) => state.user);
  const setExperiment = useCommonStore((state) => state.setExperiment);
  // Called before the early return to keep hook order stable across an undefined experiment.
  const clonedSource = useClonedFromSource(experiment?.clonedFrom);

  if (!experiment) return null;

  const { id, description, date, duration, ownerId, author, updatedAt, clonedFrom, isRaw, sourceType } = experiment;

  // Credit the author when viewing someone else's experiment; the owner already knows it's theirs.
  const showAuthor = !!author && ownerId !== user?.id;
  // Provenance: exactly one lineage line. A clone points back to its source (once that read resolves);
  // an untrimmed original recording is positively marked (raw thermal data, not a copy). A trimmed clip
  // of a video, or a clone whose source is unavailable, simply shows neither.
  const showOriginalCapture = !clonedFrom && !!isRaw && sourceType === ExperimentType.Recording;
  // Where the author credit links (real owner → profile, seeded showcase → by-author gallery).
  const authorHref = authorProfilePath(ownerId, author);
  const isOwner = ownerId === user?.id;
  // A viewer on a description-less experiment sees no empty box; the owner always gets it (it invites
  // them to write). No separate heading: this sits at the top of the already-"Description" tab.
  const showDescription = !!description || isOwner;

  // The subject leads the right group as the "Subject" fact. SUBJECT_META has no entry for null /
  // legacy "N/A", so a viewer on an unclassified experiment gets no Subject row; the owner always does
  // (to add/edit). Mirrors ExperimentSubject's own null-guard so the label never shows without a value.
  const subjectMeta = experiment.subject ? SUBJECT_META[experiment.subject] : undefined;
  const showSubject = isOwner || !!subjectMeta;

  // The rest of the right group is owner-only. showRight gates the whole column so a viewer with no
  // subject doesn't leave an empty right track (the left group then takes the full width).
  const showVisibility = isOwner && !!experiment.visibility;
  const showHomepage = isOwner && isStaff(user);
  const showRight = showSubject || showVisibility || showHomepage;

  // Last-edit time, shown only on the owner's own experiments (a private "you last changed this on…"
  // cue). Absent on never-edited / legacy docs, so the row only appears when there's a real value.
  const updatedDate = isOwner ? (updatedAt?.toDate?.() ?? null) : null;

  return (
    <div>
      {/* Facts in two groups — the timeline (Updated/Published/Duration, Author for a viewer) on the
          left, the Subject tag + owner sharing controls on the right — then the description below;
          the rate + share actions live outside this component. */}
      <MetaColumns>
        <MetaList>
          {updatedDate && (
            <>
              <dt>Updated</dt>
              <dd title={dayjs(updatedDate).format('MM/DD/YYYY hh:mm a')}>
                {dayjs(updatedDate).format('MMM D, YYYY')}
              </dd>
            </>
          )}
          <dt>Published</dt>
          <dd title={dayjs(date).format('MM/DD/YYYY hh:mm a')}>{dayjs(date).format('MMM D, YYYY')}</dd>
          <dt>Duration</dt>
          <dd title={`${duration} seconds`}>{formatDuration(duration)}</dd>
          {/* Author closes the timeline: it credits whose experiment this is. Only shown on someone
              else's experiment — the owner already knows it's theirs. */}
          {showAuthor && (
            <>
              <dt>Author</dt>
              {/* Real owners link to their profile; seeded-showcase authors (ownerId 'system', no
                  profile doc) link to their by-author showcase gallery instead. */}
              <dd>{authorHref ? <Link to={authorHref}>{author}</Link> : author}</dd>
            </>
          )}
          {/* Provenance — a clone links back to its source; an original recording is marked as such. */}
          {clonedFrom && clonedSource && (
            <>
              <dt>Cloned from</dt>
              <dd>
                <Link to={`/experiments/${clonedSource.id}`}>{clonedSource.displayName}</Link>
              </dd>
            </>
          )}
          {showOriginalCapture && (
            <>
              <dt>Source</dt>
              <dd>Original capture</dd>
            </>
          )}
        </MetaList>

        {showRight && (
          <MetaList>
            {showSubject && (
              <>
                <dt>Subject</dt>
                {/* The subject tag, editable inline by the owner (badge + pencil), a read-only badge
                    for everyone else — the same control that used to sit beside the title. */}
                <dd>
                  <ExperimentSubject experiment={experiment} />
                </dd>
              </>
            )}
            {/* Owner-only visibility picker — deciding right after recording/analyzing is the natural
                moment, so it lives here as well as in the card menus. The store copy is synced so a
                later auto-save (which passes experiment.visibility) writes the new tier. */}
            {showVisibility && experiment.visibility && (
              <>
                <dt>Visibility</dt>
                <dd>
                  <VisibilitySelect
                    expId={id}
                    value={experiment.visibility}
                    onChanged={(v) => setExperiment(id, { ...experiment, visibility: v })}
                  />
                </dd>
              </>
            )}
            {/* Staff-only: feature this experiment on the site homepage (also promotes it to Public).
                Syncs both flags into the store so the Visibility picker above and a later auto-save
                see the promotion. */}
            {showHomepage && (
              <>
                <dt>Homepage</dt>
                {/* Homepage's value is a bare switch, not a bordered select. Indent it by the small
                    Select's content inset (1px border + 7px padding) so the switch lines up under the
                    Subject / Visibility icons inside the boxes above, not out at their left edge. */}
                <dd style={{ paddingInlineStart: 8 }}>
                  <FeatureToggle
                    expId={id}
                    ownerId={ownerId}
                    featured={!!experiment.featured}
                    visibility={experiment.visibility}
                    onChanged={({ featured, visibility }) => setExperiment(id, { ...experiment, featured, visibility })}
                  />
                </dd>
              </>
            )}
          </MetaList>
        )}
      </MetaColumns>

      {showDescription && (
        <div style={{ marginTop: 16 }}>
          <Content key={id} expId={id} description={description} ownerId={ownerId} />
        </div>
      )}
    </div>
  );
};

export default Description;

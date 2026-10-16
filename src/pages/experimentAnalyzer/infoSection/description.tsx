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
import { formatIntervalSec, formatSpeedFactor, isTimelapse, playbackSpeedFactor } from '../../../utils/frameTime';
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

// The facts as a strip of small cells, each a quiet uppercase label OVER its value (Subject / Published /
// Updated / Author / Cloned from / Camera / System / Time-lapse). Stacking label over value is
// what keeps the strip tidy however it wraps: every cell is the same two-line shape, so a second row on a
// narrow panel reads as more of the same rather than as labels and values drifting into a run-on
// sentence (the old inline "label value label value" row). The labels are the Info tab's one eyebrow
// style (11px caps, same as the Digital Twin's section titles); the values are 14px ink, a shade bolder
// than prose so the eye lands on them. Still a real definition list (each fact a div wrapping its dt/dd,
// valid HTML5) so assistive tech reads term/description pairs. dd is a 24px-tall flex row so a plain
// text value sits level with the Subject pill (24px) in the cell beside it.
const Facts = styled.dl`
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 14px 32px;

  .fact {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  dt {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    line-height: 14px;
    color: var(--ifi-text-tertiary);
  }
  dd {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 24px;
    font-size: 14px;
    line-height: 20px;
    font-weight: 500;
    color: var(--ifi-ink);
    overflow-wrap: anywhere;
  }
  /* A small warm flag beside a value — "Incomplete" on a time-lapse that stopped before its plan. */
  .fact-flag {
    display: inline-flex;
    align-items: center;
    height: 18px;
    padding: 0 6px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--ifi-heat-text);
    background: rgba(240, 140, 30, 0.12);
  }
`;

const Description = ({ experiment }: DescriptionProps) => {
  const user = useCommonStore((state) => state.user);
  // Called before the early return to keep hook order stable across an undefined experiment.
  const clonedSource = useClonedFromSource(experiment?.clonedFrom);

  if (!experiment) return null;

  const { id, description, date, ownerId, author, updatedAt, clonedFrom, cameraModel, phoneOs } = experiment;
  // A time-lapse (docs/time-lapse-experiments.md): its interval and whether it ran to its planned end.
  const timelapse = isTimelapse(experiment) ? experiment.timelapse : undefined;

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
  // cue). Absent on never-edited / legacy docs. Left out when it falls on the publish day — then it says
  // nothing the Published cell doesn't, and the two identical dates side by side read as a mistake.
  const updatedDate = isOwner ? (updatedAt?.toDate?.() ?? null) : null;
  const showUpdated = !!updatedDate && !dayjs(updatedDate).isSame(dayjs(date), 'day');

  return (
    <div>
      {/* The facts strip — Subject / Published / Updated / Author (for a viewer) / Cloned from / Camera /
          System / Time-lapse — then the description below; the rate + share actions live
          outside this component. The owner's sharing controls (Visibility / Homepage) live in the
          header's settings menu. */}
      <Facts>
        {/* The subject pill leads: the one categorical fact, editable inline by the owner (a dropdown
            behind the pill), read-only for everyone else — the same control that used to sit beside the
            title. */}
        {showSubject && (
          <div className="fact">
            <dt>Subject</dt>
            <dd>
              <ExperimentSubject experiment={experiment} />
            </dd>
          </div>
        )}
        <div className="fact">
          <dt>Published</dt>
          <dd title={dayjs(date).format('MM/DD/YYYY hh:mm a')}>{dayjs(date).format('MMM D, YYYY')}</dd>
        </div>
        {showUpdated && (
          <div className="fact">
            <dt>Updated</dt>
            <dd title={dayjs(updatedDate).format('MM/DD/YYYY hh:mm a')}>{dayjs(updatedDate).format('MMM D, YYYY')}</dd>
          </div>
        )}
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
        {/* Capture setup — the camera and the phone OS the app recorded this with (app uploads only;
            older ones and other sources carry neither, so nothing shows). */}
        {cameraModel && (
          <div className="fact">
            <dt>Camera</dt>
            <dd>{cameraModel}</dd>
          </div>
        )}
        {phoneOs && (
          <div className="fact">
            <dt>System</dt>
            <dd>{phoneOs}</dd>
          </div>
        )}
        {/* A time-lapse take: how far apart its frames are and how much faster than real time it plays,
            flagged when it stopped short of its plan. Its duration
            elsewhere on the page is the real span, not the playback. */}
        {timelapse && (
          <div className="fact">
            <dt>Time-lapse</dt>
            <dd>
              <span>
                {`every ${formatIntervalSec(timelapse.intervalSec)} · plays ${formatSpeedFactor(playbackSpeedFactor(experiment))} real time`}
              </span>
              {experiment.complete === false && (
                <span className="fact-flag" title="Ended before its planned end">
                  Incomplete
                </span>
              )}
            </dd>
          </div>
        )}
      </Facts>

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

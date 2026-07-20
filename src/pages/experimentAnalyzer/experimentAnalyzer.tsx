import { Link, useParams } from 'react-router-dom';
import { Empty, Modal } from 'antd';
import VideoPlayer from './videoPlayer/videoPlayer';
import ImagePlayer from './imagePlayer/imagePlayer';
import Spinner from '../../components/spinner';
import {
  Experiment,
  ExperimentDoc,
  ExperimentType,
  ShowcasePreset,
  TComment,
  Thermometer,
  Visibility,
} from '../../types';
import { useEffect, useState } from 'react';
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import { firebaseDatabase, firebaseStorage } from '../../services/firebase';
import useCommonStore from '../../stores/common';
import { getBlob, ref } from 'firebase/storage';
import { parsePresetThermometer } from '../../utils/showcaseReader';
import InfoSection from './infoSection/infoSection';
import BackToTop from '../../components/backToTop';
import { recordHistory } from '../../services/experiments';
import { recordView } from '../../services/stats';

const fakeThermometers: Thermometer[] = [];

const ExperimentAnalyzer = () => {
  const { expId } = useParams();

  const experiment = useCommonStore((state) => (expId ? state.experimentMap.get(expId) : undefined));
  const user = useCommonStore((state) => state.user);
  const [notFound, setNotFound] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  // Bumped by the toolbar's Reset button; folded into the player's key so a reset remounts it (reloading
  // annotations from source and resetting each player's local view state — view mode, playhead, tool page).
  const [resetKey, setResetKey] = useState(0);

  /** comments live at experiments/{expId}/comments (same path for showcases and user clips) */
  const fetchComments = async (expId: string) => {
    const comments: TComment[] = [];
    const querySnapshot = await getDocs(collection(firebaseDatabase, `experiments/${expId}/comments`));
    querySnapshot.forEach((d) => {
      // id comes from the doc id; it is not stored in the document (rules whitelist excludes it).
      const comment = { ...d.data(), id: d.id } as TComment;
      useCommonStore.getState().setComment(comment.id, comment);
      comments.push(comment);
    });
    return comments;
  };

  /** recording-sourced: thermometers live in experiments/{expId}/thermometers */
  const fetchThermometers = async (expId: string, expOwnerId: string) => {
    // "Rules are not filters": an unfiltered list of a subcollection whose read rule depends on
    // per-doc data (visibility/ownerId) is rejected. Filter to match the rule (own docs, or public).
    const coll = collection(firebaseDatabase, `experiments/${expId}/thermometers`);
    const me = useCommonStore.getState().user?.id;
    const q =
      me && me === expOwnerId
        ? query(coll, where('ownerId', '==', me))
        : query(coll, where('visibility', 'in', [Visibility.Public, Visibility.Unlisted]));
    const querySnapshot = await getDocs(q);
    const thermometers: Thermometer[] = [];
    querySnapshot.forEach((d) => {
      const thermometer = d.data() as Thermometer;
      useCommonStore.getState().setThermometer(thermometer.id, thermometer);
      thermometers.push(thermometer);
    });
    fakeThermometers.forEach((thermometer) => {
      useCommonStore.getState().setThermometer(thermometer.id, thermometer);
      thermometers.push(thermometer);
    });
    return thermometers.map((t) => t.id);
  };

  /** video-sourced: thermometers come from the .wrk preset in Storage */
  const fetchPresetThermometers = async (expId: string, name: string) => {
    const presetBlob = await getBlob(ref(firebaseStorage, `videostore/${name}.wrk`));
    const preset = JSON.parse(await presetBlob.text()) as ShowcasePreset;
    const { ids, thermometers } = parsePresetThermometer(expId, preset);
    thermometers.forEach((thermometer) => useCommonStore.getState().setThermometer(thermometer.id, thermometer));
    return ids;
  };

  /** fetch the merged experiment doc, hydrate with thermometer/comment ids, cache it */
  const fetchExperiment = async (expId: string) => {
    try {
      const docSnap = await getDoc(doc(firebaseDatabase, `experiments/${expId}`));
      if (!docSnap.exists()) {
        console.warn('cannot find experiment', expId);
        setNotFound(true);
        return;
      }
      const data = docSnap.data() as ExperimentDoc;
      const comments = await fetchComments(expId);
      // Video defaults come from the .wrk preset; a clone saved with edited thermometers carries
      // them in the subcollection instead (flagged customThermometers). Recordings always use it.
      const thermometersId =
        data.sourceType === ExperimentType.Video
          ? data.customThermometers
            ? await fetchThermometers(expId, data.ownerId)
            : await fetchPresetThermometers(expId, data.name ?? '')
          : await fetchThermometers(expId, data.ownerId);

      useCommonStore.getState().setExperiment(expId, {
        ...(data as unknown as Experiment),
        id: expId,
        segments: data.segments ?? [],
        thermometersId,
        commentsId: comments.map((c) => c.id),
      });
    } catch (e) {
      // A private experiment read by a non-owner is rejected by the Firestore rules
      // (code 'permission-denied'): show a sign-in hint rather than let the rejection go
      // uncaught and the page hang on the spinner. Anything else is a genuine load failure.
      if ((e as { code?: string })?.code === 'permission-denied') {
        setAccessDenied(true);
      } else {
        console.error('failed to load experiment', expId, e);
        setNotFound(true);
      }
    }
  };

  // Always refetch on navigation so edits / new comments / rating changes show on revisit
  // (rather than serving a stale cached experiment).
  useEffect(() => {
    if (!expId) return;
    setNotFound(false);
    setAccessDenied(false);
    fetchExperiment(expId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expId]);

  // Clear per-clip thermometer/comment caches when leaving the analyzer.
  useEffect(() => {
    return () => useCommonStore.getState().clearAnalysisCaches();
  }, []);

  // Record the view into the user's history (deduped by expId) for the Recent page.
  useEffect(() => {
    if (experiment && user) {
      recordHistory(user, experiment).catch((e) => console.error('failed to record history', e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [experiment?.id, user?.id]);

  // Bump the experiment's view count. Separate from recordHistory: anonymous visitors count
  // too. The server re-checks everything, but skip the call for the cases the client already
  // knows won't count (own clip / not public-or-unlisted) — those are the most common analyzer
  // loads, and each skipped call saves a function invocation + a Firestore read.
  useEffect(() => {
    if (!experiment?.id) return;
    const isOwner = !!user && experiment.ownerId === user.id;
    const countable = experiment.visibility === Visibility.Public || experiment.visibility === Visibility.Unlisted;
    if (!isOwner && countable) recordView(experiment.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [experiment?.id]);

  // Toolbar "Reset" (non-owner only): the analyzer is a local sandbox — a viewer's thermometer /
  // annotation placements, isotherm & chart toggles and view changes live only on this page and are
  // never written back. Reset discards them by reloading the experiment from source (re-seeds the
  // author's thermometers and resets graphsOptions) and remounting the player via a bumped key (which
  // reloads annotations from source and resets each player's local view state). Confirm first: it
  // throws away hand-placed thermometers and notes the viewer may not want to lose.
  const resetAnalysis = () => {
    if (!expId) return;
    Modal.confirm({
      title: 'Reset all your changes?',
      content:
        'This discards the thermometers, annotations and view changes you made here and restores the original experiment. It never affects the owner’s copy.',
      okText: 'Reset',
      okButtonProps: { danger: true },
      onOk: async () => {
        const store = useCommonStore.getState();
        store.selectThermometer(null);
        store.setMaximizedChart(null); // transient "look closer" view — drop it so reset opens the normal layout
        // Drop the two per-experiment store slices that fetchExperiment doesn't re-derive and that are
        // otherwise cleared only on LEAVING the analyzer (clearAnalysisCaches): the viewer's mirrored
        // annotation edits and any attached Q&A frames. Leaving analyzerAnnotations behind would let the
        // remounted persistence hook baseline the stale edited notes, then falsely re-raise the "unsaved
        // changes" banner the moment <Annotations> reloads the source notes; leaving attachedMoments would
        // keep stale moment chips in the Ask AI composer.
        store.setStore((s) => s.analyzerAnnotations.delete(expId));
        store.clearAttachedMoments();
        await fetchExperiment(expId);
        setResetKey((k) => k + 1);
      },
    });
  };

  const showPlayer = () => {
    if (!experiment) return;
    // Key on the experiment id so navigating between experiments remounts the player instead of
    // reusing the instance. Reuse would keep init() from re-running (it's keyed on recordingId,
    // which two clips of the same recording share) so the new thermometers stay at value 0, and
    // would carry over the previous clip's player-index-keyed frame caches (wrong frames per clip).
    // resetKey is folded in so the toolbar's Reset also forces a fresh remount (see resetAnalysis).
    const playerKey = `${experiment.id}:${resetKey}`;
    return experiment.sourceType === ExperimentType.Video ? (
      <VideoPlayer key={playerKey} experiment={experiment} onReset={resetAnalysis} />
    ) : (
      <ImagePlayer key={playerKey} experiment={experiment} onReset={resetAnalysis} />
    );
  };

  if (accessDenied) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <Empty description="This experiment is private. Sign in with the owner account to view it.">
          <Link to="/">Back to home</Link>
        </Empty>
      </div>
    );
  }
  if (notFound) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <Empty description="Oops… we cannot find this experiment.">
          <Link to="/">Back to home</Link>
        </Empty>
      </div>
    );
  }
  if (!experiment) return <Spinner tip="Loading experiment…" />;

  // Vertical layout: the player + workspace fill the first screen (analyzer-top). The workspace carries
  // the experiment's identity (title / subject / rating-share) as a fixed header plus the Info / Charts /
  // Ask AI / AI Report tabs, so the title and description are visible without scrolling. Only the comments
  // and related list ride the page scroll below the fold. The page scrolls inside `.content`.
  return (
    <div className="experiment-analyzer">
      <div className="analyzer-top">{showPlayer()}</div>
      <div className="analyzer-below-fold">
        <InfoSection experiment={experiment} />
      </div>
      <BackToTop />
    </div>
  );
};

export default ExperimentAnalyzer;

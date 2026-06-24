import { Link, useParams } from 'react-router-dom';
import { Empty } from 'antd';
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
import { recordHistory } from '../../services/experiments';

const fakeThermometers: Thermometer[] = [];

const ExperimentAnalyzer = () => {
  const { expId } = useParams();

  const experiment = useCommonStore((state) => (expId ? state.experimentMap.get(expId) : undefined));
  const user = useCommonStore((state) => state.user);
  const [notFound, setNotFound] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);

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
      const thermometersId =
        data.sourceType === ExperimentType.Video
          ? await fetchPresetThermometers(expId, data.name ?? '')
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

  const showPlayer = () => {
    if (!experiment) return;
    return experiment.sourceType === ExperimentType.Video ? (
      <VideoPlayer experiment={experiment} />
    ) : (
      <ImagePlayer experiment={experiment} />
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

  return (
    <div className="experiment-analyzer">
      <div className="left-content">
        <InfoSection experiment={experiment} />
      </div>
      <div className="right-content">{showPlayer()}</div>
    </div>
  );
};

export default ExperimentAnalyzer;

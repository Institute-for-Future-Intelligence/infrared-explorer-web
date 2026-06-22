import { useParams } from 'react-router-dom';
import VideoPlayer from './videoPlayer/videoPlayer';
import ImagePlayer from './imagePlayer/imagePlayer';
import {
  Experiment,
  ShowcasePreset,
  ShowcaseData,
  ExperimentType,
  TemperatureUnit,
  Thermometer,
  TComment,
} from '../../types';
import { useEffect } from 'react';
import { collection, doc, getDoc, getDocs } from 'firebase/firestore';
import { firebaseDatabase, firebaseStorage } from '../../services/firebase';
import useCommonStore from '../../stores/common';
import showcases from '../../../db/showcases.json';
import { getBlob, ref } from 'firebase/storage';
import { parsePresetThermometer, parseShowcaseData } from '../../utils/showcaseReader';
import InfoSection from './infoSection/infoSection';

const fakeThermometers: Thermometer[] = [
  // { id: 'fake-id-001', x: 0.1, y: 0.25, value: 999, unit: TemperatureUnit.celsius },
  // { id: 'fake-id-002', x: 0.5, y: 0.5, value: 999, unit: TemperatureUnit.celsius },
  // { id: 'fake-id-003', x: 0.91, y: 0.85, value: 999, unit: TemperatureUnit.celsius },
  // { id: 'fake-id-004', x: 0.5, y: 0.9, value: 999, unit: TemperatureUnit.celsius },
];

const ExperimentAnalyzer = () => {
  const { expType, userId, expId } = useParams();

  const experiment = useCommonStore((state) => (expId ? state.experimentMap.get(expId) : undefined));

  const getCommentPath = (expId: string, userId: string | null, isShowcase?: boolean) => {
    if (isShowcase) {
      return `showcases/${expId}/comments`;
    } else if (userId) {
      return `users/${userId}/experiments/${expId}/comments`;
    } else {
      return null;
    }
  };

  /** Imager Player: fetch experiment and store to common store */
  const fetchExperiment = async (userId: string, expId: string) => {
    const docRef = doc(firebaseDatabase, `users/${userId}/experiments/${expId}`);
    const docSnap = await getDoc(docRef);

    if (docSnap.exists()) {
      const experiment = docSnap.data() as Experiment;
      const thermometers = await fetchThermometers(userId, expId);
      const commentPath = getCommentPath(expId, userId);
      const comments = await fetchComments(commentPath);
      useCommonStore.getState().setExperiment(experiment.id, {
        ...experiment,
        commentsId: comments.map((c) => c.id),
        thermometersId: thermometers.map((t) => t.id),
      });
    } else {
      console.log('can not find experiment', expId);
    }
  };

  /** Imager Player: fetch thermometers and store to common store */
  const fetchThermometers = async (userId: string, expId: string) => {
    const querySnapshot = await getDocs(
      collection(firebaseDatabase, `users/${userId}/experiments/${expId}/thermometers`),
    );
    const thermometers: Thermometer[] = [];
    querySnapshot.forEach((doc) => {
      const thermometer = doc.data() as Thermometer;
      useCommonStore.getState().setThermometer(thermometer.id, thermometer);
      thermometers.push(thermometer);
    });
    fakeThermometers.forEach((thermometer) => {
      useCommonStore.getState().setThermometer(thermometer.id, thermometer);
      thermometers.push(thermometer);
    });
    return thermometers;
  };

  /** fetch comments and save to common store */
  const fetchComments = async (path: string | null) => {
    const comments: TComment[] = [];
    if (!path) return comments;

    const querySnapshot = await getDocs(collection(firebaseDatabase, path));
    querySnapshot.forEach((doc) => {
      const comment = doc.data() as TComment;
      useCommonStore.getState().setComment(comment.id, comment);
      comments.push(comment);
    });
    return comments;
  };

  //** Video Player */
  const createExperimentForShowcase = async (expId: string) => {
    const showcase = showcases.find((showCase) => showCase.id === expId) as ShowcaseData | undefined;
    if (!showcase) return;

    // get preset data
    const presetBlob = await getBlob(ref(firebaseStorage, `videostore/${showcase.name}.wrk`));
    const commentPath = getCommentPath(expId, null, true);
    const comments = await fetchComments(commentPath);

    const fileReader = new FileReader();
    fileReader.onloadend = () => {
      const res = fileReader.result;
      if (res) {
        const preset = JSON.parse(res as string) as ShowcasePreset;
        const { ids, thermometers } = parsePresetThermometer(expId, preset);

        const experiment = parseShowcaseData(showcase);

        useCommonStore
          .getState()
          .setExperiment(expId, { ...experiment, thermometersId: ids, commentsId: comments.map((c) => c.id) });
        thermometers.forEach((thermometer) => {
          useCommonStore.getState().setThermometer(thermometer.id, thermometer);
        });
      }
    };
    fileReader.readAsText(presetBlob);
  };

  useEffect(() => {
    if (!userId || !expId || experiment) return;
    if (expType === ExperimentType.Image) {
      fetchExperiment(userId, expId);
    } else if (expType === ExperimentType.Video) {
      createExperimentForShowcase(expId);
    }
  }, [expType, userId, expId, experiment]);

  const showPlayer = () => {
    if (!experiment) return;

    switch (expType) {
      case ExperimentType.Video: {
        return <VideoPlayer experiment={experiment} />;
      }
      case ExperimentType.Image: {
        return <ImagePlayer experiment={experiment} />;
      }
    }
  };

  console.log('exp analyzer', experiment);

  if (!experiment) return <div>loading...</div>;

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

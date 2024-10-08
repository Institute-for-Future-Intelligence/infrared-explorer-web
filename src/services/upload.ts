import { doc, setDoc } from 'firebase/firestore';
import { firebaseDatabase } from './firebase';

const users = [
  {
    id: '60356e65473c670004e08033',
    email: 'xiaotong@intofuture.org',
    role: 'Admin',
    displayName: 'Xiaotong Ding',
    nickname: 'Xiaotong',
    clipCount: 5,
    commentCount: 1,
    disallowCopy: false,
    disallowNewsletter: false,
    disallowNotification: false,
    createdAt: '2021-02-23T21:06:45.512Z',
    experiments: [
      {
        id: '604a482b6af85bfdd19076d0',
        author: '',
        currentFrameNumber: 4409,
        currentFrameNumberInJoinedSegments: 4409,
        date: '2021-03-11T16:41:15.254Z',
        description: 'This is the session operated by Rundong.\n\nOriginal Episode.',
        displayName: '2021-03-11 session 1',
        duration: 1188.6,
        graphsOptions: [1, 2],
        thermometers: [
          {
            id: '617fcd2c-82c3-4738-b802-c8ccd70bbd5b',
            unit: 'celsius',
            value: 56.03000000000003,
            x: 0.39197139198016384,
            y: 0.20716828995951925,
            measuringAreaHeight: null,
            measuringAreaType: null,
            measuringAreaWidth: null,
          },
          {
            id: 'd5282a2f-5c23-499c-8e50-053beaccfadc',
            unit: 'celsius',
            value: 23.420000000000016,
            x: 0.39329594563774484,
            y: 0.501986159465878,
            measuringAreaHeight: null,
            measuringAreaType: null,
            measuringAreaWidth: null,
          },
          {
            id: '1babdfc5-cb2e-45c9-9002-e274e3c0a825',
            unit: 'celsius',
            value: 9.150000000000034,
            x: 0.3952345307922176,
            y: 0.8179716140592422,
            measuringAreaHeight: null,
            measuringAreaType: null,
            measuringAreaWidth: null,
          },
        ],
        timeStamp: '02/13/2022 06:34 pm',
        type: 'live-recording',
        unit: 'celsius',
        lineplot: null,
        scatterplotX: null,
        scatterplotY: null,
        annotations: null,
        thumbnailFrame: 1,
        userId: '60356e65473c670004e08033',
        recordingId: '604a482bdbd2ea0022533210',
        viewCount: 24,
      },
      {
        id: '603d6c1c6af85bfdd1bd441e',
        author: '',
        currentFrameNumber: 1,
        currentFrameNumberInJoinedSegments: 1,
        date: '2021-03-01T22:35:08.379Z',
        description: 'asdasd',
        displayName: 'Clip 2021-03-01T22:35:08.379Z',
        duration: 174.4,
        graphsOptions: [1, 2],
        thermometers: [
          {
            id: '330c41f6-4707-409f-992b-657c197f47ad',
            unit: 'celsius',
            value: 24.160000000000025,
            x: 0.42362334042438843,
            y: 0.7796620103615354,
            measuringAreaHeight: null,
            measuringAreaType: null,
            measuringAreaWidth: null,
          },
          {
            id: '44903edc-1960-45cf-88b7-ee5c2c597337',
            unit: 'celsius',
            value: 25.700000000000045,
            x: 0.9224680164923376,
            y: 0.4400189982785887,
            measuringAreaHeight: null,
            measuringAreaType: null,
            measuringAreaWidth: null,
          },
          {
            id: '1e249eb0-54b3-4ea2-8066-e9025d33379d',
            unit: 'celsius',
            value: 24.49000000000001,
            x: 0.6165100268697086,
            y: 0.7197521029980894,
            measuringAreaHeight: null,
            measuringAreaType: null,
            measuringAreaWidth: null,
          },
        ],
        timeStamp: '11/01/2023 02:05 pm',
        type: 'live-recording',
        unit: 'celsius',
        annotations: null,
        lineplot: null,
        scatterplotX: null,
        scatterplotY: null,
        thumbnailFrame: 1,
        userId: '60356e65473c670004e08033',
        recordingId: '603d6c1cf170b300227f06bb',
        viewCount: 6,
      },
      {
        id: '603c57ad6af85bfdd162e910',
        author: 'Xiaotong',
        currentFrameNumber: 160,
        currentFrameNumberInJoinedSegments: 160,
        date: '2021-03-01T02:55:41.635Z',
        description: '',
        displayName: 'Untitled',
        duration: 42.8,
        graphsOptions: [1],
        lineplot: null,
        scatterplotX: null,
        scatterplotY: null,
        thermometers: [
          {
            id: '591d5557-7671-40de-9830-9349a11ec71b',
            measuringAreaHeight: null,
            measuringAreaType: null,
            measuringAreaWidth: null,
            unit: 'celsius',
            value: 30.58000000000004,
            x: 0.3314275999417106,
            y: 0.5213828939036164,
          },
        ],
        timeStamp: '08/15/2022 04:43 pm',
        type: 'live-recording',
        unit: 'celsius',
        annotations: null,
        thumbnailFrame: 1,
        userId: '60356e65473c670004e08033',
        recordingId: '603c57a0533cf00023402f6c',
        viewCount: 8,
      },
      {
        id: '608b57cb1443430023ddd163',
        annotations: [
          {
            x: 0.3592471806422349,
            y: 0.4479950958047124,
            dx: 0.28483328153443155,
            dy: -0.349108152069032,
            note: 'sdfsdf',
            time: { start: 0, end: 6 },
            id: '4a51dd49-cee1-45fc-a6ab-f2a6a5b3ca03',
          },
        ],
        author: 'Xiaotong',
        currentFrameNumber: 1,
        currentFrameNumberInJoinedSegments: 1,
        date: '2021-04-30T01:05:15.675Z',
        description: '',
        displayName: '红外线实验',
        duration: 7.8,
        graphsOptions: [1],
        lineplot: null,
        scatterplotX: null,
        scatterplotY: null,
        thermometers: [
          {
            id: '53c22207-294e-490a-a82f-df96d5c415f8',
            measuringAreaHeight: null,
            measuringAreaType: null,
            measuringAreaWidth: null,
            unit: 'celsius',
            value: 11.78000000000003,
            x: 0.848349146110057,
            y: 0.531633005210691,
          },
        ],
        timeStamp: '06/08/2022 03:32 pm',
        type: 'live-recording',
        unit: 'celsius',
        thumbnailFrame: 1,
        userId: '60356e65473c670004e08033',
        recordingId: '60889ce5be8811002206f25a',
        segments: [{ start: 1, end: 39 }],
        viewCount: 15,
      },
      {
        id: '60f6e4b193685ed4f4a84264',
        annotations: [],
        author: '60356e65473c670004e08033',
        currentFrameNumber: 8,
        currentFrameNumberInJoinedSegments: 8,
        date: '2021-07-20T14:58:57.610Z',
        description: '',
        displayName: 'Untitled',
        duration: 238.2,
        graphsOptions: [],
        lineplot: {},
        scatterplotX: {},
        scatterplotY: {},
        thermometers: [],
        timeStamp: '02/06/2023 07:37 pm',
        type: 'live-recording',
        unit: 'celsius',
        thumbnailFrame: 1,
        userId: '60356e65473c670004e08033',
        recordingId: '60f6e4b11a88130022b706b6',
        viewCount: 8,
      },
    ],
  },
  {
    id: '5fb99060cd30210004704d8c',
    email: 'xiaotong.ding0223@gmail.com',
    role: 'student',
    displayName: 'Xiaotong Ding',
    clipCount: 3,
    commentCount: 5,
    createdAt: '2020-11-21T22:10:40.710Z',
    experiments: [
      {
        id: '608b08b5d0aae60022afe22d',
        annotations: [
          { x: 0.25, y: 0.25, dx: 0.1, dy: 0.1, note: 'sdfsdf', id: '6832bf59-15c3-4b92-aa48-b8e41621b2c4' },
        ],
        author: 'Xiaotong Ding',
        currentFrameNumber: 1,
        currentFrameNumberInJoinedSegments: 1,
        date: '2021-04-08T21:02:13.655Z',
        description: '',
        displayName: '红外线实验',
        duration: 3.6,
        graphsOptions: [],
        lineplot: null,
        scatterplotX: null,
        scatterplotY: null,
        thermometers: [],
        timeStamp: '2021-04-08T21:02:13.655Z',
        type: 'live-recording',
        unit: 'celsius',
        thumbnailFrame: 1,
        userId: '5fb99060cd30210004704d8c',
        recordingId: '606f497ac7c6d50022504cd0',
        segments: [{ start: 1, end: 18 }],
        viewCount: 5,
      },
      {
        id: '608b08cdd0aae60022afe250',
        annotations: [],
        author: 'Xiaotong Ding',
        currentFrameNumber: 1,
        currentFrameNumberInJoinedSegments: 1,
        date: '2021-04-29T19:27:49.006Z',
        description: '',
        displayName: 'sdfsdf',
        duration: 3.6,
        graphsOptions: [],
        lineplot: {},
        scatterplotX: {},
        scatterplotY: {},
        thermometers: [],
        timeStamp: '2021-04-29T19:27:49.006Z',
        type: 'live-recording',
        unit: 'celsius',
        thumbnailFrame: 1,
        userId: '5fb99060cd30210004704d8c',
        recordingId: '606f497ac7c6d50022504cd0',
        segments: [{ start: 1, end: 18 }],
        viewCount: 3,
      },
      {
        id: '608b0d93d0aae60022afe55b',
        annotations: [
          {
            x: 0.7334941756653346,
            y: 0.3475697063671668,
            dx: 0.02543859649122806,
            dy: -0.07225609756097559,
            note: 'Salt solution',
            id: '42e88a97-25d4-4379-9cd8-0ecfb378bbbc',
          },
          {
            x: 0.5131578947368421,
            y: 0.3381097560975609,
            dx: 0.03201754385964914,
            dy: -0.07073170731707316,
            note: 'Water',
            id: '923210c2-7268-485d-8b0b-ef3b441c70a5',
          },
          {
            x: 0.19078947368421054,
            y: 0.34542682926829266,
            dx: 0.032017543859649125,
            dy: -0.07530487804878047,
            note: 'Salt solution',
            id: '608b88f3-d596-463e-85d5-c10f5be942bc',
          },
          {
            x: 0.25333820793360334,
            y: 0.45917413103487126,
            dx: -0.0018957345971563914,
            dy: 0.11475409836065574,
            note: 'higher concentration',
            id: '2e8dade3-8b44-4322-ab1e-bcf9c8c6cc15',
          },
          {
            x: 0.7214714714714715,
            y: 0.44592668024439924,
            dx: 0.10000000000000002,
            dy: 0.1,
            note: 'new annotation',
            id: '7ef7a16b-43e7-4ad9-a251-b9909acc1548',
          },
        ],
        author: 'Xiaotong Ding',
        currentFrameNumber: 58,
        currentFrameNumberInJoinedSegments: 58,
        date: '2021-04-29T12:52:42.277Z',
        description:
          '<div>There exists a persistent, anomalous, temperature gradient in a cup of salt solution that lasts for as long as the solution exists. This phenomenon is counter-intuitive because the bottom of the cup is warmer than the top. In this experiment, I used two cup of salt solutions, which was contrasted by a cup of water in the middle. The temperature gradient existed in both solutions.</div><div><br></div>This result was originally published in: https://pubs.acs.org/doi/abs/10.1021/ed1009656',
        displayName: '红外线实验',
        duration: 28.2,
        graphsOptions: [1],
        lineplot: { symbolCount: 0, lineWidth: 3.5 },
        scatterplotX: null,
        scatterplotY: null,
        thermometers: [
          {
            id: '32eae04c-55d1-4471-af18-8b9b9ec05893',
            measuringAreaHeight: 0.05090909090909091,
            measuringAreaType: 'Rectangle',
            measuringAreaWidth: 0.1680129240710824,
            unit: 'celsius',
            value: 20.297500000000014,
            x: 0.4535702746365105,
            y: 0.386520878892013,
          },
          {
            id: '3ba1b873-a60b-482a-8b93-a3179ddc2732',
            measuringAreaHeight: 0.24830699774266365,
            measuringAreaType: 'Rectangle',
            measuringAreaWidth: 0.3003003003003003,
            unit: 'celsius',
            value: 20.72535714285715,
            x: 0.47355264091201127,
            y: 0.6960172813274917,
          },
          {
            id: '34b0166e-b9f6-4379-9cbc-62d94d80b48c',
            measuringAreaHeight: 0.04363636363636364,
            measuringAreaType: 'Rectangle',
            measuringAreaWidth: 0.15347334410339256,
            unit: 'celsius',
            value: 20.3125,
            x: 0.1879324320494289,
            y: 0.3864596521372159,
          },
          {
            id: 'dd62b104-655b-4199-a3d7-788cf944025f',
            measuringAreaHeight: 0.055757575757575756,
            measuringAreaType: 'Rectangle',
            measuringAreaWidth: 0.15993537964458804,
            unit: 'celsius',
            value: 21.011250000000018,
            x: 0.18885483221509078,
            y: 0.7892135475910578,
          },
        ],
        timeStamp: '04/29/2021 04:09 pm',
        type: 'live-recording',
        unit: 'celsius',
        thumbnailFrame: 1,
        userId: '5fb99060cd30210004704d8c',
        recordingId: '608aac141ec2370022900407',
        segments: [{ start: 1, end: 141 }],
        viewCount: 6,
      },
    ],
  },
];

const comments = [
  {
    id: '6077484ffdc91e0022fed267',
    expID: '603c57ad6af85bfdd162e910',
    content: 'z',
    date: '04/14/2021 15:53',
    senderID: '5fb99060cd30210004704d8c',
    senderName: 'Xiaotong Ding',
  },
  {
    id: '607249a88ac9e8002215f06e',
    expID: '603d6c1c6af85bfdd1bd441e',
    content: 'haha',
    date: '04/10/2021 20:58',
    senderID: '5fb99060cd30210004704d8c',
    senderName: 'Xiaotong Ding',
  },
  {
    id: '60774860fdc91e0022fed271',
    expID: '604a482b6af85bfdd19076d0',
    content: 'a',
    date: '04/14/2021 15:54',
    senderID: '5fb99060cd30210004704d8c',
    senderName: 'Xiaotong Ding',
  },
  {
    id: '607748a2fdc91e0022fed277',
    expID: '604a482b6af85bfdd19076d0',
    content: 'z',
    date: '04/14/2021 15:55',
    senderID: '5fb99060cd30210004704d8c',
    senderName: 'Xiaotong Ding',
  },
  {
    id: '607a11721750b00022aef170',
    expID: '604a482b6af85bfdd19076d0',
    content: 'hg',
    date: '04/16/2021 18:36',
    senderID: '5fb99060cd30210004704d8c',
    senderName: 'Xiaotong Ding',
  },
];

const ratings = [
  {
    id: '6072497b8ac9e8002215f05c',
    expID: '603d6c1c6af85bfdd1bd441e',
    userID: '5fb99060cd30210004704d8c',
    rating: 5,
  },
  {
    id: '6072497b8ac9e8002215f05b',
    expID: '603d6c1c6af85bfdd1bd441e',
    userID: '5fb99060cd30210004704d8c',
    rating: 4,
  },
  {
    id: '6072497b8ac9e8002215f05a',
    expID: '603d6c1c6af85bfdd1bd441e',
    userID: '5fb99060cd30210004704d8c',
    rating: 2,
  },
  {
    id: '6077482afdc91e0022fed256',
    expID: '604a482b6af85bfdd19076d0',
    userID: '5fb99060cd30210004704d8c',
    rating: 3,
  },
];

export const uploadRatings = async () => {
  for (const rating of ratings) {
    const r = { ...rating };
    // @ts-ignore
    delete r.expID;
    await setDoc(
      doc(firebaseDatabase, `users/60356e65473c670004e08033/experiments/${rating.expID}/ratings/${rating.id}`),
      r,
    );
  }
};

export const uploadComments = async () => {
  for (const comment of comments) {
    const c = { ...comment };
    // @ts-ignore
    delete c['expID'];
    await setDoc(
      doc(firebaseDatabase, `users/60356e65473c670004e08033/experiments/${comment.expID}/comments/${comment.id}`),
      c,
    );
  }
};

const uploadUser = async (user: any) => {
  const userDoc = { ...user };
  delete userDoc.experiments;
  await setDoc(doc(firebaseDatabase, 'users', user.id), userDoc);

  if (user.experiments) {
    for (const experiment of user.experiments) {
      const experimentDoc = { ...experiment };
      delete experimentDoc.thermometers;
      delete experimentDoc.annotations;
      await setDoc(doc(firebaseDatabase, `users/${user.id}/experiments/${experiment.id}`), experimentDoc);

      if (experiment.thermometers) {
        for (const thermometer of experiment.thermometers) {
          await setDoc(
            doc(firebaseDatabase, `users/${user.id}/experiments/${experiment.id}/thermometers/${thermometer.id}`),
            thermometer,
          );
        }
      }
      if (experiment.annotations) {
        for (const annotation of experiment.annotations) {
          await setDoc(
            doc(firebaseDatabase, `users/${user.id}/experiments/${experiment.id}/annotations/${annotation.id}`),
            annotation,
          );
        }
      }
    }
  }
};

export const uploadUsers = () => {
  users.forEach(uploadUser);
};

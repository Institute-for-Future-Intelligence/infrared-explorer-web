/**
 * What the twin agent is told (docs/digital-twin-plan.md §43.5): the goal and what "done" is, the
 * questions it must be able to answer before it builds — not how to answer them — a few principles,
 * the picture convention its program must follow, and one worked example of a sound build (the ice
 * and salt recording this was first done on), so the model knows what a good measurement looks like
 * and can do the like on a hot cup or a hand on the bench. The tools are described in their schemas;
 * the camera and its data in the shared base prompt.
 */
import { SAFETY_RULE } from '../labCore/config';
import { basePrompt } from '../labCore/prompt';

export interface TwinAgentSetting {
  expId: string;
  title: string;
}

export const TWIN_AGENT_MAX_BUILDS = 3;

export function twinAgentPrompt(s: TwinAgentSetting): string {
  const lines = [
    basePrompt('web', 'recording'),
    '',
    'Your task in this conversation',
    `- Build a 3D digital twin of the recording "${s.title}" (take ${s.expId}): a small three.js scene of the bench and the things on it, which the website then paints with the recording's own temperatures, frame by frame as the player plays, through a camera that stands still above the bench. The user is not in this conversation: it starts with what the website knows about the recording and ends when you call finish. Write what you say for the user, who reads along.`,
    '- Done means: the scene, seen from that camera, lines up with the thermal frame — build_scene scores it, object by object, and says pass or fail — every thing that may be at a different temperature is a part of its own (one part over two dishes would paint both with one value), and every assumption you made is written down in finish.',
    '',
    'Before you build, you must be able to answer, with evidence from the data, not from a glance',
    '- What is in the picture, and what the experiment is.',
    '- Where each thing is, exactly, in thermal grid pixels: its centre and its extent. Measured by your own code on the temperature data (a threshold between the things and the bench, connected regions, centroids), or on the visible-light picture when the thermal frame shows no contrast (a bare metal object reflects the room and reads like the bench).',
    '- When things change: the frame something is added, moves or starts to melt, so you build from a frame where the things are still, and know which frames to verify against.',
    '- Whether the camera looks straight down. This flow is for a still camera over a bench; a camera that moved or looks sideways is not yours to model — say so and call finish with what you have, naming the problem in assumptions.',
    'How you answer them is up to you: look at frames, plot a histogram of a frame, run code over frames. Write any helper you need inside run_code; nothing is measured for you.',
    '',
    'Principles',
    '- The thermal frame is the truth about where things are; the visible-light picture is not pixel-aligned with it (a few percent of the width off), so measure on the thermal grid wherever the thermal frame shows the thing.',
    '- Measure first, then build: every position and size in the program comes from your object table, converted with the picture convention below; nothing is placed by eye.',
    '- One part per thing that may differ in temperature: each dish, each cup, the bench. Give a dish its base and rim as meshes of the same part, and its contents as another part.',
    '- The bench is the whole picture: a slab the size of the field of view (and a little beyond), its top at y = 0.',
    '- Absolute size cannot be measured from the picture. Choose it once, from what the things are (a Petri dish is 90 mm, a mug 80 mm across), state it as cameraHeightM, and list it in assumptions. Heights you cannot see are assumptions too.',
    `- Build at most ${TWIN_AGENT_MAX_BUILDS} times. The score comes back with each build; a failing object says how far off and how much too large or small it is, so one correction is usually enough. When the budget is spent, finish with the best build.`,
    '- Do not model what the frame does not show (no imagined tools, no hands), and do not add trees, people or decoration.',
    '',
    'The picture convention (build_scene enforces it)',
    '- Units are metres, y up, the bench top at y = 0, the picture centre at x = 0, z = 0.',
    '- The camera is at (0, cameraHeightM, 0) looking straight down. Picture right is +x; picture DOWN (towards the bottom of the frame) is +z.',
    '- The thermal picture is 160 pixels tall and 120 wide, portrait. It spans H = 2 · cameraHeightM · tan(27.5°) metres top to bottom and W = 0.75 · H left to right. So a grid pixel is m = H / 160 metres, and a thing measured at pixel (cx, cy) with radius r pixels is placed at x = (cx − 60) · m, z = (cy − 80) · m, with radius r · m.',
    '',
    'A sound build, as it went once (two dishes of ice on a bench, salt added to one)',
    '1. look at three moments (the start, the middle, the end), thermal and visible: two round dishes, one above the other, on a plain bench; the lower one darkens on the thermal picture after 35 s.',
    '2. run_code: a histogram of frame 1 shows two peaks, 3 °C and 22 °C — the dishes and the bench; the threshold goes between them (12 °C). The mean of the first 150 frames (before anything changed) under that threshold, split into 4-connected regions, gives two regions: centroids (58.5, 46.8) and (58.2, 114.3), equivalent radii 25.0 and 25.5 px. Both measured on the thermal grid.',
    '3. The dishes are Petri dishes, 90 mm across: 45 mm = 25.3 px, so a pixel is 1.78 mm and H = 0.285 m, which makes cameraHeightM = 0.285 / (2 · tan 27.5°) = 0.274 m. Written down as an assumption.',
    '4. build_scene: a bench slab 0.4 × 0.5 m with its top at y = 0; two parts dishA and dishB, each a thin plastic cylinder (radius 45 mm, 2 mm) on the bench and a 10 mm open rim; two parts iceA and iceB, cylinders of radius 42 mm and height 9 mm inside; centres at z = (46.8 − 80) · 0.00178 = −0.059 m and (114.3 − 80) · 0.00178 = +0.061 m, x ≈ −0.003 m. The score: both objects within 2 px, IoU above 0.85, pass.',
    '5. finish with the subject, the four parts, the program, the object table, and the assumptions (90 mm dishes; ice 9 mm thick, not visible from above).',
    '',
    SAFETY_RULE,
  ];
  return lines.join('\n');
}

/**
 * What the twin agent is told (docs/digital-twin-plan.md §43.5, trimmed in §44.7): the goal and what
 * "done" is, the questions it must be able to answer before it builds — not how to answer them — and
 * the facts about the data and about the program the viewer runs that it cannot find out for itself.
 * Nothing here says how to measure, where the camera is, what things are or what a sound build looks
 * like: the model works that out from the pictures and the numbers, and build_scene tells it how far
 * off it is. The tools are described in their schemas; the camera and its data in the shared base prompt.
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
    `- Build a 3D digital twin of the recording "${s.title}" (take ${s.expId}): a small three.js scene of what the camera saw, which the website then paints with the recording's own temperatures, frame by frame as the player plays, through the camera you say the recording was made with — the camera stood still for the whole recording. The conversation starts with what the website knows about the recording; the owner may write to you later, asking for changes. A round ends when you call finish: the twin saved then replaces the one before, so after a change finish again with the whole program. Write what you say for the owner, who reads along. The name and the description you give finish show beside the twin — one or two short sentences, all the owner is told; the assumptions are kept for the record and not shown. Write nothing else with the finish call, and nothing after it.`,
    '- Done means: the scene, seen from that camera, lines up with the thermal frame — build_scene scores it, object by object, and says pass or fail — every thing that may be at a different temperature is a part of its own (one part over two dishes would paint both with one value), and every assumption you made is written down in finish.',
    '',
    'Before you build, you must be able to answer, with evidence from the data, not from a glance',
    '- What is in the picture, and what the experiment is.',
    '- Where each thing is, exactly, in thermal grid pixels: its centre and its extent.',
    '- When things change: the frame something is added, moves or starts to melt, so you build from a frame where the things are still, and know which frames to verify against.',
    'How you answer them is up to you: look at frames, plot a histogram of a frame, run code over frames. Write any helper you need inside run_code; nothing is measured for you.',
    '',
    'What is known about the data',
    '- The thermal frame is the truth about where things are; the visible-light picture is not pixel-aligned with it (a few percent of the width off).',
    '- The thermal picture is 160 pixels tall and 120 wide, portrait; the object table is in those pixels.',
    '- Absolute size cannot be measured from the pictures. Whatever scale you choose, and whatever you cannot see, goes in assumptions.',
    '',
    'What the program must follow (the viewer runs it)',
    '- Units are metres, y up, the ground — or the bench top — at y = 0. The camera you give is in these same coordinates.',
    '- Every part is declared with api.part, so the viewer can paint each one with its own temperatures.',
    `- Build at most ${TWIN_AGENT_MAX_BUILDS} times. The score comes back with each build; a failing object says how far off and how much too large or small it is. When the budget is spent, finish with the best build.`,
    '',
    SAFETY_RULE,
  ];
  return lines.join('\n');
}

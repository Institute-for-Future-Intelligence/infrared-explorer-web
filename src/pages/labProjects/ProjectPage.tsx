/*
 * One AI lab project (/projects/:projectId): the conversation (Discuss),
 * the plan, the captures and the report — the four tabs of the app's
 * project page. On a wide window Discuss sits on the left, with the title
 * in its head and the message box at its foot, and the other three share a
 * tab strip on the right; under 900px the four are one tab strip, as in
 * the app.
 *
 * Signed in, the page asks for the project as the owner (labProjectGet)
 * and holds the conversation: messages, the model before the first one,
 * the AI data agreement, the quota, Generate Report, Edit Plan, and the
 * title-row menu (Rename / Share… / AI Usage / Delete Project) with the
 * share chip in the title's facts (how it is shared; a click opens Share), and the
 * captures: "+" beside the message box adds the account's own experiments
 * (the website has no camera), they wait in a tray until a message carries
 * them with their overviews, and the Captures tab's menu takes one out. A
 * call the AI makes for the browser (look, run_code) runs here; one left
 * open (a reload, or the app closed mid-run) is answered when the page
 * opens (resumePending). The run itself lives in labProjects/runner.ts and
 * the bundle in labProjects/store.ts, so leaving the page does not stop a
 * reply. When the
 * project belongs to someone else it opens as a shared project instead
 * (labProjectOpenShared with the link's `k`), read-only, which needs no
 * account — the path https://ie.intofuture.org/projects/<id>?k=<token> is
 * also the app's deep link on both platforms (public/.well-known), so a
 * shared view offers Open in App (to a signed-in reader; signed out, the
 * title row has none). The app repository's
 * docs/proposals/ai-projects-web.md, P0 + P1 + P2.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button, Modal, Spin, Tabs, message } from 'antd';
import styled from 'styled-components';
import useCommonStore from '../../stores/common';
import { signIn } from '../../services/auth';
import { firebaseAuth } from '../../services/firebase';
import { ensureUgcConsent } from '../../services/ugcConsent';
import { isStaff } from '../../utils/staff';
import { useIsMobile, useMediaMaxWidth } from '../../hooks/useIsMobile';
import Breadcrumbs from '../../components/breadcrumbs';
import EmptyState from '../../components/emptyState';
import type { ExperimentCard } from '../../hooks/useExperimentLists';
import {
  attachExperiment,
  callableCode,
  deleteProject,
  editProject,
  fetchQuota,
  getProject,
  openSharedProject,
  shareProject,
  type EditPatch,
} from '../../labProjects/api';
import { hasProjectConsent, providerNameFor, recordProjectConsent } from '../../labProjects/consent';
import { captureNumbers } from '../../labProjects/core/captureNumbers';
import { isEmptyProject, shownTitle } from '../../labProjects/core/empty';
import { reportModelName } from '../../labProjects/core/models';
import { discussPictureSequence, markdownPictureSequence, planPictureSequence } from '../../labProjects/core/pictures';
import { quotaDialogMessage } from '../../labProjects/core/quota';
import { hasReportMaterial } from '../../labProjects/core/reportMaterial';
import { statusLabel } from '../../labProjects/core/runStatus';
import {
  quotaLine,
  type ProjectBundle,
  type ProjectImage,
  type QuotaLeft,
  type SharedBundle,
  type ShareVisibility,
  type Take,
} from '../../labProjects/core/types';
import { discardIfEmpty } from '../../labProjects/discard';
import {
  cancelTurn,
  clearUnsent,
  dismissConsent,
  pendingPhoneCalls,
  requestReport,
  resendAfterConsent,
  resume,
  resumePending,
  sendMessage,
  useProjectRun,
  waitingTakes,
} from '../../labProjects/runner';
import { dropBundle, refreshBundle, setBundle, updateBundle, useBundle } from '../../labProjects/store';
import AttachmentTray, { type AddingCapture } from '../../labProjects/components/AttachmentTray';
import CapturesTab from '../../labProjects/components/CapturesTab';
import Composer from '../../labProjects/components/Composer';
import ConsentDialog from '../../labProjects/components/ConsentDialog';
import Discuss from '../../labProjects/components/Discuss';
import ExperimentPickerModal from '../../labProjects/components/ExperimentPickerModal';
import Lightbox from '../../labProjects/components/Lightbox';
import ModelPicker from '../../labProjects/components/ModelPicker';
import OpenInApp from '../../labProjects/components/OpenInApp';
import PlanEditorModal from '../../labProjects/components/PlanEditorModal';
import PlanTab from '../../labProjects/components/PlanTab';
import ProjectMenu from '../../labProjects/components/ProjectMenu';
import ReportTab from '../../labProjects/components/ReportTab';
import ShareChip from '../../labProjects/components/ShareChip';
import ShareDialog from '../../labProjects/components/ShareDialog';
import { thumbnailHttps } from '../../labProjects/experimentThumbs';
import { ago, showsFailedCalls } from '../../labProjects/format';
import { useCloudThumbs } from '../../labProjects/useCloudThumbs';

/** Below this width the four tabs share one strip, as in the app. */
const TWO_PANE_MIN_PX = 900;
/** While the AI is at work elsewhere, or the project waits for the app, how often the page looks again. */
const BUSY_POLL_MS = 10_000;
/** The box is off with this line while a call the AI made stands open; the page answers it (resumePending) as soon as it can. */
const WAITING_FOR_ANSWER = 'The AI asked for something from a capture; answering it…';
/** How close to the bottom Discuss must be to follow new words down. */
const FOLLOW_PX = 160;

type View =
  | { kind: 'loading' }
  /** The owner's own: the bundle is the store's (labProjects/store.ts). */
  | { kind: 'owner' }
  | { kind: 'shared'; shared: SharedBundle; bundle: ProjectBundle }
  | { kind: 'error'; code: string | null };

type TabKey = 'discuss' | 'plan' | 'captures' | 'report';
type SideKey = Exclude<TabKey, 'discuss'>;

/** The shared project as the pieces expect it: every take "on the phone" at no path, and told to the AI. */
function asBundle(s: SharedBundle): ProjectBundle {
  return {
    project: {
      ...s.project,
      takes: s.project.takes.map((t) => ({
        ...t,
        localPath: '',
        announced: true,
        cloud: t.cloud ? { expId: t.cloud.expId, at: 0 } : undefined,
      })),
      modelChoices: null,
    },
    turns: s.turns,
    images: s.images,
  };
}

const Page = styled.div<{ $wide: boolean }>`
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: ${(p) => (p.$wide ? '100%' : 'auto')};
  max-width: 1400px;
  margin: 0 auto;
  padding: ${(p) => (p.$wide ? '12px 16px 12px' : '8px 8px 32px')};

  /* How you got here (components/breadcrumbs.tsx): one quiet line over the title's card, as the analyzer has over its player. */
  .pp-crumbs {
    flex: none;
    margin-bottom: 8px;
  }
  /* The title and its facts sit in the Discuss pane's head (wide) or above the one tab strip (narrow): no page header of their own. */
  .pp-head {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 18px 10px;
    border-bottom: 1px solid var(--ifi-stroke-1);
  }
  .pp-head-narrow {
    border-bottom: 0;
    padding: 4px 4px 10px;
  }
  .pp-title-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .pp-title-row h1 {
    font-family: var(--ifi-font-display);
    font-size: 18px;
    font-weight: 600;
    line-height: 1.3;
    color: var(--ifi-ink);
    min-width: 0;
    flex: 1;
    margin: 0;
  }
  .pp-meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 10px;
    font-size: 12.5px;
    color: var(--ifi-text-tertiary);
  }
  .pp-split {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(360px, 5fr) minmax(360px, 6fr);
    gap: 16px;
  }
  .pp-pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: var(--ifi-panel);
    border: 1px solid var(--ifi-stroke-1);
    border-radius: 12px;
    overflow: hidden;
  }
  .pp-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .pp-note {
    flex: none;
    padding: 9px 18px;
    border-top: 1px solid var(--ifi-stroke-1);
    font-size: 12.5px;
    color: var(--ifi-text-tertiary);
    text-align: center;
  }
  .pp-pane .ant-tabs {
    height: 100%;
  }
  .pp-pane .ant-tabs-nav {
    margin: 0;
    padding: 0 16px;
  }
  .pp-pane .ant-tabs-content-holder {
    min-height: 0;
    overflow-y: auto;
  }
  .pp-one {
    background: var(--ifi-panel);
    border: 1px solid var(--ifi-stroke-1);
    border-radius: 12px;
  }
  .pp-one .ant-tabs-nav {
    margin: 0;
    padding: 0 12px;
  }
  .pp-center {
    display: flex;
    justify-content: center;
    padding: 64px 0;
  }
  /* an owner's empty Discuss: the question, and the model to answer it with */
  .pp-empty {
    max-width: 520px;
    margin: 24px auto 8px;
    padding: 0 8px;
  }
  .pp-empty h2 {
    font-family: var(--ifi-font-display);
    font-size: 20px;
    font-weight: 600;
    color: var(--ifi-ink);
    margin: 0 0 8px;
  }
  .pp-empty p {
    font-size: 14.5px;
    line-height: 1.5;
    color: var(--ifi-text-secondary);
    margin: 0;
  }
`;

const ProjectPage = () => {
  const { projectId = '' } = useParams();
  const [params] = useSearchParams();
  const token = params.get('k');
  const navigate = useNavigate();
  const user = useCommonStore((state) => state.user);
  const authReady = useCommonStore((state) => state.authReady);
  const signedIn = user != null;
  const staff = isStaff(user);
  // the account's Firebase uid keys the consent note (projects belong to the uid; User.id is the mongoId)
  const authUid = user ? (firebaseAuth.currentUser?.uid ?? user.id) : '';

  const [view, setView] = useState<View>({ kind: 'loading' });
  // the owner's bundle came from the server in this page (what discardIfEmpty may trust)
  const confirmed = useRef(false);
  // Delete Project was done here: nothing to discard on the way out
  const deleted = useRef(false);
  const load = useCallback(async () => {
    if (!projectId) {
      setView({ kind: 'error', code: 'not-found' });
      return;
    }
    if (signedIn) {
      try {
        setBundle(await getProject(projectId));
        confirmed.current = true;
        setView({ kind: 'owner' });
        return;
      } catch (e) {
        const code = callableCode(e);
        if (code !== 'permission-denied') {
          setView({ kind: 'error', code });
          return;
        }
        // someone else's: open it as shared, with the link's token if there is one
      }
    }
    try {
      const shared = await openSharedProject(projectId, token);
      setView({ kind: 'shared', shared, bundle: asBundle(shared) });
    } catch (e) {
      setView({ kind: 'error', code: callableCode(e) });
    }
  }, [projectId, token, signedIn]);
  useEffect(() => {
    if (!authReady) {
      return;
    }
    confirmed.current = false;
    deleted.current = false;
    setView({ kind: 'loading' });
    load();
  }, [authReady, load]);

  // An empty project is not kept (labProjects/discard.ts): leaving its page
  // deletes it, on the server's word that it is empty.
  useEffect(
    () => () => {
      if (confirmed.current && !deleted.current) {
        discardIfEmpty(projectId);
      }
    },
    [projectId],
  );

  const stored = useBundle(projectId);
  const bundle = view.kind === 'owner' ? stored : view.kind === 'shared' ? view.bundle : null;
  const shared = view.kind === 'shared' ? view.shared : null;
  const owner = view.kind === 'owner' && bundle != null;
  const project = bundle?.project ?? null;
  const run = useProjectRun(projectId);

  // a call the AI made stands open (this page reloaded mid-run, or the app
  // was closed): the owner's page answers it — the browser's tools, or why not
  const pending = useMemo(() => (owner ? pendingPhoneCalls(bundle) : []), [owner, bundle]);
  const waitingForApp = pending.length > 0;
  const busy = project?.busy ?? false;
  const follow = useRef(false);
  const resumedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!owner || !waitingForApp || run.running || busy) {
      return;
    }
    const key = pending.map((c) => c.id).join(',');
    if (resumedFor.current === key) {
      return;
    }
    resumedFor.current = key;
    follow.current = true;
    resumePending(projectId).catch(() => undefined);
  }, [owner, waitingForApp, run.running, busy, pending, projectId]);
  // the AI at work elsewhere, or an answer still owed: look again in a while
  const shouldPoll = bundle != null && !run.running && (busy || waitingForApp);
  useEffect(() => {
    if (!shouldPoll) {
      return;
    }
    const t = setInterval(() => {
      (owner ? refreshBundle(projectId) : load()).catch(() => undefined);
    }, BUSY_POLL_MS);
    return () => clearInterval(t);
  }, [shouldPoll, owner, projectId, load]);

  // What the account has left of its AI turns (core/quota.ts): asked of the
  // server when the page opens, then taken from every turn's answer. Staff
  // have no limit: the server answers null, and the menu leaves the row out.
  const [quota, setQuota] = useState<QuotaLeft | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setQuota(undefined);
    if (!owner || staff) {
      return;
    }
    fetchQuota()
      .then((q) => live && setQuota(q))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [owner, staff, authUid]);
  useEffect(() => {
    if (run.quota !== undefined) {
      setQuota(run.quota);
    }
  }, [run.quota]);

  // The AI data agreement (labProjects/consent.ts): asked once per account
  // before anything is sent, and again whenever the server says it has no
  // record (run.needsConsent). `afterConsent` = the send that waits for it.
  const [consentOk, setConsentOk] = useState(false);
  useEffect(() => setConsentOk(authUid ? hasProjectConsent(authUid) : false), [authUid]);
  const [afterConsent, setAfterConsent] = useState<(() => void) | null>(null);
  const askConsent = (then: () => void): boolean => {
    if (consentOk) {
      return false;
    }
    setAfterConsent(() => then);
    return true;
  };

  // the message box; a message that never got through comes back to it
  const [text, setText] = useState('');
  useEffect(() => {
    if (run.unsent != null) {
      const words = run.unsent;
      setText((prev) => (prev.trim() ? prev : words));
      clearUnsent(projectId);
    }
  }, [run.unsent, projectId]);
  const [savingModel, setSavingModel] = useState<string | null>(null);
  const editing = savingModel != null;
  // The captures waiting beside the box (added since the last message), and
  // the experiments on their way in (attachExperiment, one after another).
  const waiting = useMemo(() => (owner ? waitingTakes(bundle) : []), [owner, bundle]);
  const [adding, setAdding] = useState<AddingCapture[]>([]);
  const [picker, setPicker] = useState(false);
  const takes = project?.takes;
  const numbers = useMemo(() => captureNumbers(takes ?? []), [takes]);
  const takenExpIds = useMemo(() => new Set((takes ?? []).map((t) => t.cloud?.expId ?? '').filter(Boolean)), [takes]);
  const blocked = !owner ? null : waitingForApp && !run.running ? WAITING_FOR_ANSWER : null;
  const canAttach = owner && !run.running && !busy && blocked == null;
  const canSend =
    owner &&
    (text.trim().length > 0 || waiting.length > 0) &&
    adding.length === 0 &&
    !editing &&
    !run.running &&
    !busy &&
    blocked == null;
  const send = () => {
    const msg = text.trim();
    if (!canSend || (!msg && waiting.length === 0)) {
      return;
    }
    const go = () => {
      setText('');
      follow.current = true;
      sendMessage(projectId, msg, waiting).catch(() => undefined);
    };
    if (!askConsent(go)) {
      go();
    }
  };
  // Experiments picked to add: each is filed on the server (its take comes
  // back with its cloud copy, unannounced) and lands in the tray.
  const addExperiments = async (picked: ExperimentCard[]) => {
    const cards = picked.map((e) => ({
      key: e.id,
      thumbnailUrl: thumbnailHttps(e.thumbnailURL),
      video: e.sourceType !== 'photos',
      timelapse: !!e.timelapse && e.timelapse.intervalSec > 0,
    }));
    setAdding((prev) => [...prev, ...cards]);
    for (const e of picked) {
      try {
        const r = await attachExperiment(projectId, e.id);
        updateBundle(projectId, (b) => ({ ...b, project: r.project }));
      } catch (err) {
        const name = e.displayName?.trim() || e.name || 'the recording';
        message.error((err as Error)?.message ?? 'Could not add ' + name + '.');
      } finally {
        setAdding((prev) => prev.filter((a) => a.key !== e.id));
      }
    }
  };

  // Generate Report: until the report starts coming, the Report tab shows
  // what the AI is doing on the way.
  const [reportAsked, setReportAsked] = useState(false);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !run.running) {
      setReportAsked(false);
    }
    wasRunning.current = run.running;
  }, [run.running]);
  const turns = bundle?.turns;
  const lastAsk = useMemo(() => {
    for (let i = (turns?.length ?? 0) - 1; i >= 0; i--) {
      const t = turns![i];
      if (t.role === 'user' || t.role === 'event') {
        return t;
      }
    }
    return null;
  }, [turns]);
  // the words of the messages sent so far, for Up and Down in the message box
  const sentWords = useMemo(() => {
    const out: string[] = [];
    for (const t of turns ?? []) {
      const words = t.role === 'user' && t.request == null ? t.text?.trim() : undefined;
      if (words && words !== out[out.length - 1]) {
        out.push(words);
      }
    }
    return out;
  }, [turns]);
  const reportWorking = run.running && (reportAsked || lastAsk?.request === 'report') ? statusLabel(run.status) : null;
  const reportMaterial = useMemo(() => hasReportMaterial(bundle), [bundle]);
  const canGenerate = owner && !run.running && !busy && !waitingForApp && !editing;
  const generateReport = () => {
    if (!canGenerate || !reportMaterial) {
      return;
    }
    const go = () => {
      setReportAsked(true);
      follow.current = true;
      requestReport(projectId).catch(() => undefined);
    };
    if (!askConsent(go)) {
      go();
    }
  };

  // The user's own edits: the server keeps the project and (for the plan)
  // adds a note to the conversation; the page shows the project at once and
  // the note on refresh.
  const applyEdit = async (patch: EditPatch) => {
    const p = await editProject(projectId, patch);
    updateBundle(projectId, (b) => ({ ...b, project: p }));
    await refreshBundle(projectId).catch(() => undefined);
  };
  const pickModel = (key: string) => {
    if (editing || key === project?.chatModel?.key) {
      return;
    }
    setSavingModel(key);
    applyEdit({ chatModel: key })
      .catch((e) => {
        message.error((e as Error)?.message ?? 'Could not change the model.');
        refreshBundle(projectId).catch(() => undefined);
      })
      .finally(() => setSavingModel(null));
  };
  const [editingPlan, setEditingPlan] = useState(false);
  // Out of the project (it stays in My Experiments): the tray's × at once, the Captures tab after asking.
  const dropTake = (t: Take) => {
    applyEdit({ removeTakeId: t.takeId }).catch((e) =>
      message.error((e as Error)?.message ?? 'Could not remove it from the experiment.'),
    );
  };
  const askRemove = (t: Take) => {
    Modal.confirm({
      title: 'Remove from experiment?',
      content: 'It stays in My Recordings.',
      okText: 'Remove',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: () => dropTake(t),
    });
  };
  const rename = async (title: string) => {
    const p = await editProject(projectId, { title });
    updateBundle(projectId, (b) => ({ ...b, project: p }));
  };
  // The Share panel, from the ⋯ menu or the share chip.
  const [sharing, setSharing] = useState(false);
  // The first switch out of Private passes the site's UGC terms record, as
  // publishing an experiment does (the app's Terms sheet writes the same
  // users/{mongoId}/consents/ugcTerms); the server keeps the tier.
  const changeSharing = async (v: ShareVisibility) => {
    if (v !== 'private' && (project?.share?.visibility ?? 'private') === 'private' && user) {
      await ensureUgcConsent(user.id);
    }
    const p = await shareProject(projectId, v);
    updateBundle(projectId, (b) => ({ ...b, project: p }));
  };
  const remove = async () => {
    await deleteProject(projectId);
    deleted.current = true;
    dropBundle(projectId);
    navigate('/projects');
  };
  const usage = async () => {
    // asked again: the page's copy may be a turn or an hour old
    try {
      const q = await fetchQuota();
      setQuota(q);
      return quotaDialogMessage(q, false);
    } catch {
      return quotaDialogMessage(quota ?? undefined, false);
    }
  };

  const wide = !useMediaMaxWidth(TWO_PANE_MIN_PX - 1);
  // the breadcrumbs: desktop only, as on the analyzer
  const isMobile = useIsMobile();
  const crumbs = isMobile ? null : (
    <Breadcrumbs className="pp-crumbs" ownerId={shared?.owner.id} author={shared?.owner.name} />
  );
  const [tab, setTab] = useState<TabKey>('discuss');
  const [side, setSide] = useState<SideKey>('plan');
  const showSide = (k: SideKey) => {
    setTab(k);
    setSide(k);
  };

  const [viewer, setViewer] = useState<{ image: ProjectImage; list: ProjectImage[] } | null>(null);
  const images = useMemo(() => bundle?.images ?? [], [bundle]);
  const discussPictures = useMemo(
    () => (bundle ? discussPictureSequence(bundle.turns, bundle.images, bundle.project.busy) : []),
    [bundle],
  );
  const planMarkdown = project?.plan?.markdown ?? null;
  const planPictures = useMemo(() => planPictureSequence(planMarkdown, images), [planMarkdown, images]);
  const reportMarkdown = project?.report?.markdown ?? null;
  const reportPictures = useMemo(() => markdownPictureSequence(reportMarkdown, images), [reportMarkdown, images]);
  const reportModel = useMemo(() => (bundle ? reportModelName(bundle.turns) : null), [bundle]);
  const planPreview = run.running && run.preview?.tool === 'write_plan' ? run.preview.text : null;
  const reportPreview = run.running && run.preview?.tool === 'write_report' ? run.preview.text : null;

  const cloud = useCloudThumbs(project?.takes);
  const showFailures = showsFailedCalls(user?.email);
  const ownerName = shared ? shared.owner.name : null;

  // Discuss opens at its newest words, and follows them down while they are
  // near (a reader who scrolled up stays where they are); sending follows again.
  const discussRef = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | null>(null);
  const turnCount = turns?.length ?? 0;
  useEffect(() => {
    const el = discussRef.current;
    if (!bundle || !el) {
      return;
    }
    const first = scrolledFor.current !== bundle.project.id;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_PX;
    if (first || near || follow.current) {
      scrolledFor.current = bundle.project.id;
      follow.current = false;
      el.scrollTop = el.scrollHeight;
    }
  }, [bundle, wide, turnCount, run.liveText, run.status, run.outgoing, run.error]);

  if (view.kind === 'loading' || !authReady || (view.kind === 'owner' && !bundle)) {
    return (
      <Page $wide={false}>
        <div className="pp-center">
          <Spin />
        </div>
      </Page>
    );
  }
  if (view.kind === 'error' || !bundle || !project) {
    const code = view.kind === 'error' ? view.code : null;
    const hint = !signedIn
      ? 'It may be private, or the link may have changed. If it is yours, sign in to open it.'
      : code === 'not-found' || code === 'permission-denied' || code == null
        ? 'It may be private, no longer shared, or deleted.'
        : 'Something went wrong while opening it. Try again in a moment.';
    return (
      <Page $wide={false}>
        {crumbs}
        <EmptyState title="This experiment could not be opened" hint={hint} />
        <OpenInApp
          projectId={projectId}
          token={token}
          variant="page"
          extra={
            !signedIn && (
              <Button size="large" onClick={() => signIn().catch(() => undefined)}>
                Sign In
              </Button>
            )
          }
        />
      </Page>
    );
  }

  const emptyDiscuss = owner ? (
    <div className="pp-empty">
      <h2>What do you want to find out?</h2>
      <p>
        Describe a question, an idea for an experiment, or what you have at hand. The AI works out the experiment with
        you, draws how to set it up, and looks at what you record.
      </p>
      {project.modelChoices ? (
        <ModelPicker
          choices={project.modelChoices}
          selected={savingModel ?? project.chatModel?.key ?? null}
          disabled={editing || run.running}
          saving={editing}
          onPick={pickModel}
        />
      ) : null}
    </div>
  ) : undefined;
  const discuss = (
    <Discuss
      bundle={bundle}
      ownerName={ownerName}
      showFailures={showFailures}
      cloud={cloud}
      run={owner ? run : null}
      empty={emptyDiscuss}
      onRetry={() => {
        follow.current = true;
        resume(projectId).catch(() => undefined);
      }}
      onOpenImage={(image) => setViewer({ image, list: discussPictures })}
      onOpenPlan={() => showSide('plan')}
      onOpenReport={() => showSide('report')}
    />
  );
  const foot = owner ? (
    <Composer
      value={text}
      onChange={setText}
      history={sentWords}
      onSend={send}
      onStop={() => cancelTurn(projectId)}
      onAddFromExperiments={() => setPicker(true)}
      canAttach={canAttach}
      tray={<AttachmentTray takes={waiting} adding={adding} numbers={numbers} cloud={cloud} onRemove={dropTake} />}
      running={run.running}
      canSend={canSend}
      blocked={blocked}
      quotaLine={quotaLine(quota)}
    />
  ) : null;
  const plan = (
    <PlanTab
      project={project}
      images={images}
      editorName={ownerName}
      previewText={planPreview}
      canEdit={owner && !run.running && !busy}
      readOnly={!owner}
      onOpenImage={(image) => setViewer({ image, list: planPictures })}
      onEdit={() => setEditingPlan(true)}
    />
  );
  const captures = <CapturesTab takes={project.takes} cloud={cloud} onRemove={owner ? askRemove : undefined} />;
  const report = (
    <ReportTab
      project={project}
      images={images}
      author={ownerName}
      model={reportModel}
      previewText={reportPreview}
      working={reportWorking}
      canGenerate={canGenerate}
      hasMaterial={reportMaterial}
      readOnly={!owner}
      onOpenImage={(image) => setViewer({ image, list: reportPictures })}
      onGenerate={generateReport}
    />
  );
  const capturesLabel = project.takes.length > 0 ? `Captures · ${project.takes.length}` : 'Captures';
  const sideItems = [
    { key: 'plan', label: 'Plan', children: plan },
    { key: 'captures', label: capturesLabel, children: captures },
    { key: 'report', label: 'Report', children: report },
  ];
  const model = project.chatModel?.label ?? null;

  // the title and its facts: the head of the Discuss pane (wide), or above the tabs (narrow)
  const head = (
    <div className={wide ? 'pp-head' : 'pp-head pp-head-narrow'}>
      <div className="pp-title-row">
        <h1>{shownTitle(project.title)}</h1>
        {shared && signedIn && <OpenInApp projectId={projectId} token={token} />}
        {owner && (
          <ProjectMenu
            project={project}
            bundle={bundle}
            staff={staff}
            onRename={rename}
            onShare={() => setSharing(true)}
            onDelete={remove}
            onUsage={usage}
          />
        )}
      </div>
      <div className="pp-meta">
        {/* no status chip (user decision 2026-10-16, as on the cards) */}
        {/* an empty project is not kept once the page is left: nothing to share, as the menu's Share… */}
        {owner && (
          <ShareChip share={project.share} onClick={isEmptyProject(bundle) ? undefined : () => setSharing(true)} />
        )}
        {model && <span>{model}</span>}
        <span>Updated {ago(project.updatedAt)}</span>
        {shared && <span>by {shared.owner.name}</span>}
        {shared && <span>Read only</span>}
      </div>
    </div>
  );

  return (
    <Page $wide={wide}>
      {crumbs}
      {wide ? (
        <div className="pp-split">
          <div className="pp-pane">
            {head}
            <div className="pp-scroll" ref={discussRef}>
              {discuss}
            </div>
            {foot}
          </div>
          <div className="pp-pane">
            <Tabs activeKey={side} onChange={(k) => setSide(k as SideKey)} items={sideItems} />
          </div>
        </div>
      ) : (
        <div className="pp-one">
          {head}
          <Tabs
            activeKey={tab}
            onChange={(k) => setTab(k as TabKey)}
            items={[
              {
                key: 'discuss',
                label: 'Discuss',
                children: (
                  <>
                    {discuss}
                    {foot}
                  </>
                ),
              },
              ...sideItems,
            ]}
          />
        </div>
      )}
      <Lightbox image={viewer?.image ?? null} images={viewer?.list ?? []} onClose={() => setViewer(null)} />
      {owner && (
        <>
          <ConsentDialog
            open={afterConsent != null || run.needsConsent}
            provider={providerNameFor(project.chatModel?.label)}
            onCancel={() => {
              setAfterConsent(null);
              if (run.needsConsent) {
                dismissConsent(projectId);
              }
            }}
            onAgree={async () => {
              await recordProjectConsent(authUid);
              setConsentOk(true);
              const then = afterConsent;
              setAfterConsent(null);
              if (run.needsConsent) {
                follow.current = true;
                resendAfterConsent(projectId).catch(() => undefined);
              } else {
                then?.();
              }
            }}
          />
          <ShareDialog
            open={sharing}
            project={project}
            onClose={() => setSharing(false)}
            onVisibility={changeSharing}
          />
          <PlanEditorModal
            open={editingPlan}
            initial={project.plan?.markdown ?? ''}
            images={images}
            onClose={() => setEditingPlan(false)}
            onSave={(md) => applyEdit({ planMarkdown: md })}
          />
          {picker && user && (
            <ExperimentPickerModal
              user={user}
              takenExpIds={takenExpIds}
              onAdd={addExperiments}
              onClose={() => setPicker(false)}
            />
          )}
        </>
      )}
    </Page>
  );
};

export default ProjectPage;

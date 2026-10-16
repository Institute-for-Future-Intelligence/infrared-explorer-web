/**
 * Run the AI lab report over a fixed set of experiments, model by model, and tabulate where the time
 * went — the regression set of the latency proposal (app repo docs/proposals/ai-report-latency.md §7.1).
 *
 *   npx tsx scripts/aiReportRegression.ts --uid=<firebase uid> --exp=<id>[,<id>…] [--models=gpt6luna,deepseek-flash]
 *                                         [--repeat=3] [--json] [--dry]
 *     --uid=<uid>          the Firebase uid the runs are made AS — it must own every experiment listed
 *                          (generateLabReport is owner-only) and should be a staff account (no quota)
 *     --exp=<ids>          the experiments to report on; use CLONES made for this purpose, see below
 *     --models=<keys>      model keys as the website offers them (default: gpt6luna,deepseek-flash)
 *     --repeat=N           runs per experiment × model (default 1; the proposal's table uses 3)
 *     --json               emit the per-run rows as JSON instead of a table
 *     --dry                sign in and list the plan, call nothing
 *
 * EVERY RUN IS A REAL REPORT. It replaces the experiment's saved report, may place AI probes on it, and
 * spends provider money — so the set must be clones owned by the staff account (the analyzer's "Save to
 * My Experiments" makes one), never a student's experiment. There is no rate limit for staff; a private
 * account would burn its daily allowance in one pass.
 *
 * HOW IT MEASURES. The callable is invoked over plain HTTPS (no stream), and the wall clock around the
 * request is the client-side total. The server-side record — the `ai_report_timing` line generateLabReport
 * writes (functions/src/reportTiming.ts) — is read back from the aiReportAudit copy of it, so each row
 * carries both the stage times (access / load / seed / rounds / write / verify / persist) and the
 * figure check (checked / matched / unmatched by kind). The two totals should agree to within the
 * network; a large gap is itself a finding.
 *
 * CREDENTIALS. ./serviceAccount.json (as scripts/evalReports.ts) mints a custom token for --uid, which
 * the Identity Toolkit exchanges for an ID token carrying the account's claims (mongoId included). The
 * web API key comes from ./.env (VITE_FIREBASE_API_KEY — public, it ships with the site).
 */
import { readFileSync } from 'node:fs';
import { cert, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const arg = (name: string): string | undefined =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const UID = arg('uid');
const EXPS = (arg('exp') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MODELS = (arg('models') ?? 'gpt6luna,deepseek-flash')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const REPEAT = Math.max(1, Number(arg('repeat') ?? 1));
const AS_JSON = flag('json');
const DRY = flag('dry');

if (!UID || EXPS.length === 0) {
  console.error(
    'Usage: npx tsx scripts/aiReportRegression.ts --uid=<uid> --exp=<id>[,<id>…] [--models=…] [--repeat=N]',
  );
  process.exit(2);
}

/** ./.env's VITE_FIREBASE_API_KEY, read without a dotenv dependency (quoted or bare, spaces around =). */
function readEnvKey(name: string): string {
  const env = readFileSync('./.env', 'utf8');
  const line = env.split(/\r?\n/).find((l) => l.trim().startsWith(`${name}`));
  const value = line
    ?.split('=')
    .slice(1)
    .join('=')
    .trim()
    .replace(/^["']|["']$/g, '');
  if (!value) throw new Error(`${name} not found in ./.env`);
  return value;
}

const sa = JSON.parse(readFileSync('./serviceAccount.json', 'utf8')) as { project_id: string };
initializeApp({ credential: cert(sa as Parameters<typeof cert>[0]) });
const db = getFirestore();
const API_KEY = readEnvKey('VITE_FIREBASE_API_KEY');
const FUNCTION_URL = `https://us-central1-${sa.project_id}.cloudfunctions.net/generateLabReport`;

/** A fresh ID token for --uid: custom token → Identity Toolkit exchange. Valid for an hour. */
async function signIn(uid: string): Promise<string> {
  const custom = await getAuth().createCustomToken(uid);
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: custom, returnSecureToken: true }),
  });
  if (!res.ok) throw new Error(`signInWithCustomToken failed: HTTP ${res.status} ${await res.text()}`);
  const { idToken } = (await res.json()) as { idToken: string };
  return idToken;
}

interface Row {
  exp: string;
  model: string;
  run: number;
  ok: boolean;
  error?: string;
  /** Wall clock around the HTTPS request, ms. */
  clientMs: number;
  /** The server's own record, when its audit copy was found. */
  server?: {
    totalMs: number;
    accessMs: number | null;
    loadMs: number | null;
    seedMs: number | null;
    roundMs: number[];
    roundTools: string[];
    writeTtftMs: number | null;
    writeMs: number | null;
    writeStreamed: boolean | null;
    correctionMs: number | null;
    verifyMs: number | null;
    persistMs: number | null;
    checked: number | null;
    matched: number | null;
    unmatched: number;
    figures: number | null;
    reportChars: number | null;
    fallback: boolean;
  };
}

/** The audit document this run wrote: the newest one for the experiment written after `since`. */
async function readAudit(expId: string, since: number): Promise<Row['server'] | undefined> {
  const snap = await db.collection('aiReportAudit').where('ref', '==', expId).get();
  const docs = snap.docs
    .map((d) => ({ ms: Number(d.id.split('__').pop()), data: d.data() }))
    .filter((d) => Number.isFinite(d.ms) && d.ms >= since)
    .sort((a, b) => b.ms - a.ms);
  const a = docs[0]?.data;
  if (!a) return undefined;
  const t = (a.timing ?? {}) as Record<string, number | null>;
  return {
    totalMs: Number(t.totalMs ?? 0),
    accessMs: t.accessMs ?? null,
    loadMs: t.loadMs ?? null,
    seedMs: t.seedMs ?? null,
    roundMs: (a.roundMs ?? []) as number[],
    roundTools: (a.roundTools ?? []) as string[],
    writeTtftMs: t.writeTtftMs ?? null,
    writeMs: t.writeMs ?? null,
    writeStreamed: (a.writeStreamed ?? null) as boolean | null,
    correctionMs: a.correction ? Number((a.correction as { ms: number }).ms) : null,
    verifyMs: t.verifyMs ?? null,
    persistMs: t.persistMs ?? null,
    checked: (a.checked ?? null) as number | null,
    matched: (a.matched ?? null) as number | null,
    unmatched: Array.isArray(a.unmatched) ? a.unmatched.length : 0,
    figures: (a.figures ?? null) as number | null,
    reportChars: (a.reportChars ?? null) as number | null,
    fallback: a.fallback === true,
  };
}

async function runOnce(idToken: string, expId: string, model: string, run: number): Promise<Row> {
  const started = Date.now();
  let ok = false;
  let error: string | undefined;
  try {
    const res = await fetch(FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ data: { expId, model } }),
    });
    const body = (await res.json()) as { result?: unknown; error?: { message?: string; status?: string } };
    if (res.ok && body.result) ok = true;
    else error = body.error?.message ?? `HTTP ${res.status}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const clientMs = Date.now() - started;
  // The audit write is the last thing the function does, after the response has been sent: give it a moment.
  await new Promise((r) => setTimeout(r, 1500));
  const server = await readAudit(expId, started - 1000);
  return { exp: expId, model, run, ok, ...(error ? { error } : {}), clientMs, server };
}

const q = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const fmt = (v: number | null | undefined): string => (v == null ? '—' : `${(v / 1000).toFixed(1)}s`);

async function main(): Promise<void> {
  const plan = EXPS.flatMap((exp) =>
    MODELS.flatMap((model) => Array.from({ length: REPEAT }, (_, i) => ({ exp, model, run: i + 1 }))),
  );
  console.error(`${plan.length} run(s): ${EXPS.length} experiment(s) × ${MODELS.join(', ')} × ${REPEAT}`);
  if (DRY) {
    for (const p of plan) console.error(`  ${p.exp}  ${p.model}  #${p.run}`);
    return;
  }
  let idToken = await signIn(UID!);
  let signedInAt = Date.now();
  const rows: Row[] = [];
  for (const p of plan) {
    if (Date.now() - signedInAt > 45 * 60 * 1000) {
      idToken = await signIn(UID!);
      signedInAt = Date.now();
    }
    const row = await runOnce(idToken, p.exp, p.model, p.run);
    rows.push(row);
    const s = row.server;
    console.error(
      `${p.exp} ${p.model} #${p.run}: ${row.ok ? 'ok' : `FAILED ${row.error}`} client ${fmt(row.clientMs)}` +
        (s
          ? ` server ${fmt(s.totalMs)} = access ${fmt(s.accessMs)} + load ${fmt(s.loadMs)} + seed ${fmt(s.seedMs)} + rounds [${s.roundMs.map(fmt).join(' ')}] + write ${fmt(s.writeMs)} (ttft ${fmt(s.writeTtftMs)}${s.writeStreamed === false ? ', unstreamed' : ''})` +
            `${s.correctionMs != null ? ` + correction ${fmt(s.correctionMs)}` : ''} | figures ${s.matched ?? '—'}/${s.checked ?? '—'} matched`
          : ' (no audit record found)'),
    );
  }
  if (AS_JSON) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log(
    '\nmodel | runs | ok | client p50 | server p50 | server p90 | write p50 | ttft p50 | unstreamed | matched/checked | unmatched/run',
  );
  for (const model of MODELS) {
    const r = rows.filter((x) => x.model === model);
    const srv = r.map((x) => x.server).filter((s): s is NonNullable<Row['server']> => !!s);
    const checked = srv.reduce((n, s) => n + (s.checked ?? 0), 0);
    const matched = srv.reduce((n, s) => n + (s.matched ?? 0), 0);
    const unmatched = srv.reduce((n, s) => n + s.unmatched, 0);
    console.log(
      [
        model,
        r.length,
        r.filter((x) => x.ok).length,
        fmt(
          q(
            r.map((x) => x.clientMs),
            0.5,
          ),
        ),
        fmt(
          q(
            srv.map((s) => s.totalMs),
            0.5,
          ),
        ),
        fmt(
          q(
            srv.map((s) => s.totalMs),
            0.9,
          ),
        ),
        fmt(
          q(
            srv.map((s) => s.writeMs).filter((v): v is number => v != null),
            0.5,
          ),
        ),
        fmt(
          q(
            srv.map((s) => s.writeTtftMs).filter((v): v is number => v != null),
            0.5,
          ),
        ),
        srv.filter((s) => s.writeStreamed === false).length,
        `${matched}/${checked}`,
        srv.length ? (unmatched / srv.length).toFixed(1) : '—',
      ].join(' | '),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

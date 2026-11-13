/**
 * The site opened as an embedded window: `?viewonly=true` on the address of a recording
 * (/experiments/:expId) or of an experiment (/projects/:projectId) — the parameter AIMS and Aladdin
 * take for theirs, so an article on intofuture.org frames all three alike:
 *
 *   <iframe src="https://ie.intofuture.org/experiments/<id>?viewonly=true"></iframe>
 *
 * Embedded, the page is only what the article is showing: the player beside its workspace, or the
 * conversation beside the plan, captures and report. Layout leaves out the header, the navigation and
 * the storage notice, and the page its header card, its breadcrumbs and (the analyzer) what is below
 * the fold.
 *
 * Read once, when the app loads: the frame stays embedded whatever is opened inside it, though the
 * parameter is gone from the address after the first navigation.
 */
export const EMBEDDED =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('viewonly') === 'true';

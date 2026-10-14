import { useParams, useSearchParams } from 'react-router-dom';
import { Button, Typography } from 'antd';
import { APP_STORE_URL, PLAY_STORE_URL } from '../utils/urls';

/*
 * /projects/:projectId — the landing page of a lab project shared from the
 * mobile app (the app repo's docs/proposals/lab-project-sharing.md §3.5).
 *
 * The link https://ie.intofuture.org/projects/<id>?k=<token> is a deep link
 * of the app on both platforms (Android App Links / iOS Universal Links, via
 * public/.well-known), so on a phone with the app it never reaches this
 * page. It is for everyone else: a desktop browser, a phone without the app,
 * or a link opened inside Safari itself (a universal link tapped there does
 * not launch the app). It says what the link is and offers the app's own
 * scheme (which does launch it) and the stores. It shows nothing of the
 * project: the website has no viewer for one (user's call 2026-10-13).
 */

const { Title, Paragraph } = Typography;

const ProjectLink = () => {
  const { projectId = '' } = useParams();
  const [params] = useSearchParams();
  const token = params.get('k');
  const appUrl = `infraredexplorer://projects/${encodeURIComponent(projectId)}${
    token ? `?k=${encodeURIComponent(token)}` : ''
  }`;
  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: '48px 24px', textAlign: 'center' }}>
      <Title level={2}>A shared project</Title>
      <Paragraph type="secondary">
        This project was shared from the Infrared Explorer app. Open it in the app to read the conversation, the plan,
        the captures and the report.
      </Paragraph>
      <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', marginTop: 24 }}>
        <Button type="primary" size="large" href={appUrl}>
          Open in App
        </Button>
      </div>
      <Paragraph type="secondary" style={{ marginTop: 32 }}>
        Don&apos;t have the app yet?
      </Paragraph>
      <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
        <Button href={PLAY_STORE_URL} target="_blank" rel="noopener noreferrer">
          Google Play
        </Button>
        <Button href={APP_STORE_URL} target="_blank" rel="noopener noreferrer">
          App Store
        </Button>
      </div>
    </div>
  );
};

export default ProjectLink;

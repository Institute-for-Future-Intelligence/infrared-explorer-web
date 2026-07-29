import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import App from './App.tsx';
import { AppErrorBoundary } from './components/appErrorBoundary.tsx';
import 'katex/dist/katex.min.css';
import './index.css';

// One global antd theme — the app had none, so 67 files were rendering antd's default blue (#1677ff)
// and 6px radius alongside the brand teal. This unifies interaction colour on teal, rounds to 10px,
// and makes the rating star the brand's "heat" orange. `fontFamily` is intentionally left to antd's
// default until the display/body faces are self-hosted (P1) — pointing it at a not-yet-loaded face
// would only cost a flash.
//
// starColor here is the DISPLAY default for antd <Rate>. The analyzer's "Your rating" Rate keeps its
// own local ConfigProvider (teal), which overrides this — so a viewer's own stars stay teal while
// every other Rate reads as community "heat".
const theme = {
  token: {
    colorPrimary: '#008c8c',
    colorInfo: '#008c8c',
    colorLink: '#006e6e',
    colorLinkHover: '#005c5c',
    borderRadius: 10,
    colorTextBase: '#213547',
    motionDurationMid: '0.2s',
    motionEaseInOut: 'cubic-bezier(0.45, 0, 0.55, 1)',
  },
  components: {
    Rate: { starColor: '#f08c1e' },
    Button: { primaryShadow: '0 2px 6px rgba(0, 140, 140, 0.28)' },
  },
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ConfigProvider theme={theme}>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </ConfigProvider>,
);

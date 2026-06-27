import { FloatButton } from 'antd';

// Floating back-to-top button shared across the experiment-list pages. The app scrolls inside the
// `.content` container (not the window), so point antd's BackTop at that element. It auto-shows once
// scrolled past `visibilityHeight` and hides at the very top.
const BackToTop = () => (
  <FloatButton.BackTop
    target={() => document.querySelector('.content') as HTMLElement}
    visibilityHeight={200}
    tooltip="Back to top"
  />
);

export default BackToTop;

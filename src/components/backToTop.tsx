import { FloatButton } from 'antd';
import { matchPath, useLocation } from 'react-router-dom';
import useCommonStore from '../stores/common';
import { isStaff } from '../utils/staff';
import { useIsMobile } from '../hooks/useIsMobile';

// Floating back-to-top button shared across the experiment-list pages. The app scrolls inside the
// `.content` container (not the window), so point antd's BackTop at that element. It auto-shows once
// scrolled past `visibilityHeight` and hides at the very top.
const BackToTop = () => {
  const user = useCommonStore((state) => state.user);
  const location = useLocation();
  const isMobile = useIsMobile();
  // The Lab Assistant FAB sits in the bottom-right corner (right:24 / bottom:24, 52×52px) for staff on
  // every page. For staff, match the back-to-top button to the FAB — same 52×52 size and same right:24
  // anchor so their centres line up — and lift it above the FAB (24 + 52 + 16 gap = 92) so the two never
  // overlap. Non-staff have no FAB, so keep antd's default size/position.
  //
  // On the desktop analyzer the FAB is itself lifted to clear the Ask AI composer (AiChatWidget's
  // ANALYZER_FAB_BOTTOM = 64), so stack above that raised spot there (64 + 52 + 16 = 132) instead.
  const onDesktopAnalyzer = !isMobile && !!matchPath('/experiments/:expId', location.pathname);
  const fabClearance = onDesktopAnalyzer ? 132 : 92;
  const style = isStaff(user) ? { insetInlineEnd: 24, insetBlockEnd: fabClearance, width: 52, height: 52 } : undefined;
  return (
    <FloatButton.BackTop
      target={() => document.querySelector('.content') as HTMLElement}
      visibilityHeight={200}
      tooltip="Back to top"
      style={style}
    />
  );
};

export default BackToTop;

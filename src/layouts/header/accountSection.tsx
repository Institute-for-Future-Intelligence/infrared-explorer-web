import { lazy, Suspense } from 'react';
import useCommonStore from '../../stores/common.ts';
import Notifications from '../../components/notifications/notifications.tsx';

const MainMenu = lazy(() => import('../../components/mainMenu/mainMenu.tsx'));
const SignInButton = lazy(() => import('./signInButton.tsx'));

const AccountSection = () => {
  const user = useCommonStore((state) => state.user);

  return (
    <div className="account-section" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <Suspense>
        {user ? (
          <>
            <Notifications user={user} />
            <MainMenu user={user} />
          </>
        ) : (
          <SignInButton />
        )}
      </Suspense>
    </div>
  );
};

export default AccountSection;

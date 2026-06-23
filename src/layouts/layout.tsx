import { Outlet } from 'react-router-dom';
import Header from './header/header';
import AcceptCookie from '../components/acceptCookie';

const Layout = () => {
  return (
    <div className="app">
      <Header />
      <div className="content">
        <Outlet />
      </div>
      <AcceptCookie />
    </div>
  );
};

export default Layout;

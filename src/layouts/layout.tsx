import { Outlet } from 'react-router-dom';
import Header from './header/header';
import Sidebar from './sidebar/sidebar';
import AcceptCookie from '../components/acceptCookie';

const Layout = () => {
  return (
    <div className="app">
      <Header />
      <div className="body">
        <Sidebar />
        <div className="content">
          <Outlet />
        </div>
      </div>
      <AcceptCookie />
    </div>
  );
};

export default Layout;

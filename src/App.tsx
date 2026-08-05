import './App.css';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import ErrorPage from './pages/errorPage';
import Layout from './layouts/layout';
import './services/firebase';
import HomePage from './pages/homePage';
import Community from './pages/community';
import StreetView from './pages/streetView/streetView';
import MyExperimentsList from './pages/myExperimentsList';
import Me from './pages/me';
import ExperimentAnalyzer from './pages/experimentAnalyzer/experimentAnalyzer';
import Trash from './pages/trash';
import Recent from './pages/recent';
import Raw from './pages/raw';
import Settings from './pages/settings';
import About from './pages/about';
import Contact from './pages/contact';
import AllUsers from './pages/admin/allUsers';
import AllExperiments from './pages/admin/allExperiments';
import MyClassesPage from './pages/classroom/MyClassesPage';
import ClassDetailPage from './pages/classroom/ClassDetailPage';
import UserProfile from './pages/userProfile';
import ShowcaseAuthor from './pages/showcaseAuthor';
import { useAuthInit } from './hooks/useAuthInit';

const App = () => {
  useAuthInit();

  const router = createBrowserRouter(
    [
      {
        path: '',
        element: <Layout />,
        errorElement: <ErrorPage />,
        children: [
          {
            path: '',
            element: <HomePage />,
          },
          {
            // The open Community feed (every explorer's public experiments) — its own page in the
            // sidebar under Home, distinct from the staff-curated homepage Showcase.
            path: 'community',
            element: <Community />,
          },
          {
            // Public map of geo-tagged thermal panoramas (the app's Infrared Street View, viewer-side).
            path: 'streetview',
            element: <StreetView />,
          },
          {
            // The signed-in user's private hub: one preview row per personal collection.
            path: 'me',
            element: <Me />,
          },
          {
            path: 'myExperimentsList',
            element: <MyExperimentsList />,
          },
          {
            path: 'recent',
            element: <Recent />,
          },
          {
            path: 'raw',
            element: <Raw />,
          },
          {
            path: 'settings',
            element: <Settings />,
          },
          {
            path: 'about',
            element: <About />,
          },
          {
            path: 'contact',
            element: <Contact />,
          },
          {
            path: 'trash',
            element: <Trash />,
          },
          {
            path: 'admin/users',
            element: <AllUsers />,
          },
          {
            path: 'admin/experiments',
            element: <AllExperiments />,
          },
          {
            // Drill-in from a user's "Clips" count on the All Users page — same view, owner-scoped.
            path: 'admin/users/:ownerId/experiments',
            element: <AllExperiments />,
          },
          {
            path: 'classroom',
            element: <MyClassesPage />,
          },
          {
            path: 'classroom/:classId',
            element: <ClassDetailPage />,
          },
          {
            path: 'experiments/:expId',
            element: <ExperimentAnalyzer />,
          },
          {
            // Public user profile (usersPublic slice + the owner's public experiments);
            // readable by anyone, including signed-out visitors.
            path: 'users/:userId',
            element: <UserProfile />,
          },
          {
            // Read-only gallery for a seeded-showcase author (grouped by the `author` string, since
            // the showcases all share ownerId:'system' and have no usersPublic profile).
            path: 'showcase/authors/:author',
            element: <ShowcaseAuthor />,
          },
          {
            path: '*',
            element: <ErrorPage />,
          },
        ],
      },
    ],
    {
      // Opt in early to React Router v7 behavior; also silences the v6 future-flag warnings.
      future: { v7_relativeSplatPath: true },
    },
  );

  return <RouterProvider router={router} future={{ v7_startTransition: true }} />;
};

export default App;

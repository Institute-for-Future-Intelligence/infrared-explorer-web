import './App.css';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import ErrorPage from './pages/errorPage';
import Layout from './layouts/layout';
import './services/firebase';
import HomePage from './pages/homePage';
import Community from './pages/community';
import StreetView from './pages/streetView/streetView';
import MyExperimentsList from './pages/myExperimentsList';
import ExperimentAnalyzer from './pages/experimentAnalyzer/experimentAnalyzer';
import Trash from './pages/trash';
import Recent from './pages/recent';
import Account from './pages/account';
import About from './pages/about';
import Contact from './pages/contact';
import DeleteAccountPage from './pages/deleteAccount';
import AllUsers from './pages/admin/allUsers';
import AllExperiments from './pages/admin/allExperiments';
import StreetViewReports from './pages/admin/streetViewReports';
import MyClassesPage from './pages/classroom/MyClassesPage';
import ClassDetailPage from './pages/classroom/ClassDetailPage';
import ClassReportPage from './pages/classroom/ClassReportPage';
import UserProfile from './pages/userProfile';
import ShowcaseAuthor from './pages/showcaseAuthor';
import ProjectsPage from './pages/labProjects/ProjectsPage';
import ProjectPage from './pages/labProjects/ProjectPage';
import { useAuthInit } from './hooks/useAuthInit';
import useCommonStore from './stores/common';

/*
 * /me — once the private hub page (2026-10-16 .. 2026-11-03), now a redirect to the signed-in user's
 * public profile: "Me" in the sidebar IS the profile (user 2026-11-03), and the hub's private rows
 * have sidebar entries of their own (Trash included); Raw Data, the originals-only view of My
 * Recordings, went with it.
 * Waits for the session restore so a hard refresh of /me doesn't bounce a signed-in user home.
 */
const MeRedirect = () => {
  const user = useCommonStore((state) => state.user);
  const authReady = useCommonStore((state) => state.authReady);
  if (!authReady) return null;
  return <Navigate to={user ? `/users/${user.id}` : '/'} replace />;
};

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
            // Kept for old links: sends the signed-in user to their public profile.
            path: 'me',
            element: <MeRedirect />,
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
            path: 'account',
            element: <Account />,
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
            // Google Play's user-data policy requires a public URL where deletion can be
            // requested without the app — this is the one declared in the Data safety form.
            // Keep the path stable: it is published on the store listing.
            path: 'delete-account',
            element: <DeleteAccountPage />,
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
            // The moderation queue. Linked from the weekly digest e-mail, so keep the path stable.
            path: 'admin/streetview-reports',
            element: <StreetViewReports />,
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
            // One report a student handed in, as the teacher reads it (the minimal classroom).
            path: 'classroom/:classId/reports/:projectId',
            element: <ClassReportPage />,
          },
          {
            path: 'experiments/:expId',
            element: <ExperimentAnalyzer />,
          },
          {
            // AI Project: the signed-in user's AI lab projects that were uploaded (or shared) from
            // the mobile app (src/labProjects/, src/pages/labProjects/). The path stays /projects
            // because the app's Android / iOS link registrations (public/.well-known) claim
            // /projects/*; the user-visible name is "Projects" (the list: "My Projects").
            path: 'projects',
            element: <ProjectsPage />,
          },
          {
            // One project, read-only: the owner's own, or one shared from the app
            // (https://ie.intofuture.org/projects/<id>?k=<token> is the app's deep link on both
            // platforms; in a browser it opens here, with Open in App beside it). Keep the path
            // stable: public/.well-known names it.
            path: 'projects/:projectId',
            element: <ProjectPage />,
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

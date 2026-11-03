import { Suspense, lazy, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from './components/AppShell';
import { Mark } from './components/Logo';
import { RequireDatasetPermission, RequirePermission, SessionGate } from './features/auth/AccessGate';
import { InvitationPage } from './features/auth/InvitationPage';
import { SignInPage } from './features/auth/SignInPage';
import { SsoOutcomeToast } from './features/auth/SsoOutcome';
import { DatasetPage } from './features/datasets/DatasetPage';
import { DatasetsPage } from './features/datasets/DatasetsPage';
import { DetailPage } from './features/detail/DetailPage';
import { CreateMaterializationPage } from './features/materializations/CreateMaterializationPage';
import { EditMaterializationPage } from './features/materializations/EditMaterializationPage';
import { MaterializationsPage } from './features/materializations/MaterializationsPage';
import { OverviewPage } from './features/overview/OverviewPage';
import { SearchPage } from './features/search/SearchPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { TablePage } from './features/tables/TablePage';
import { DomainScope, domainPath, useDomain } from './lib/domains';

// Explore is a workspace of its own: its code loads when it is first opened, never with another page.
const ExplorePage = lazy(() => import('./features/explore/ExplorePage').then((module) => ({ default: module.ExplorePage })));

/**
 * The console's pages (handbook 20): every domain at `/`, `/materializations`, `/datasets`,
 * `/explore` and `/search`; the console's own settings at `/settings`; everything about one domain
 * under `/d/<domain>/`; and, outside the shell, signing in and accepting an invitation.
 */
export function App(): ReactNode {
  return (
    <SessionGate>
      <SsoOutcomeToast />
      <Routes>
        <Route path="/sign-in" element={<SignInPage />} />
        <Route path="/sign-in/:domain" element={<SignInPage />} />
        <Route path="/invitation" element={<InvitationPage />} />
        <Route path="*" element={<ShellRoutes />} />
      </Routes>
    </SessionGate>
  );
}

function ShellRoutes(): ReactNode {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/materializations" element={<Materializations />} />
        <Route path="/datasets" element={<Datasets />} />
        <Route path="/explore" element={<Explore />} />
        <Route path="/explore/:explorationId" element={<Explore />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/:section" element={<SettingsPage />} />
        <Route path="/settings/:section/:itemId" element={<SettingsPage />} />
        <Route
          path="/d/:domain/*"
          element={
            <DomainScope>
              <DomainRoutes />
            </DomainScope>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}

/** One domain's pages, under `/d/<domain>/`. */
function DomainRoutes(): ReactNode {
  return (
    <Routes>
      <Route index element={<Overview />} />
      <Route path="materializations" element={<Materializations />} />
      <Route
        path="materializations/new"
        element={
          <RequirePermission permission="materializations.create" what="creating a materialization">
            <CreateMaterializationPage />
          </RequirePermission>
        }
      />
      <Route
        path="materializations/:materializationId"
        element={
          <RequirePermission permission="materializations.view_details" what="this materialization">
            <DetailPage />
          </RequirePermission>
        }
      />
      <Route
        path="materializations/:materializationId/edit"
        element={
          <RequirePermission permission="materializations.edit" what="changing a materialization">
            <EditMaterializationPage />
          </RequirePermission>
        }
      />
      <Route
        path="materializations/:materializationId/:tab"
        element={
          <RequirePermission permission="materializations.view_details" what="this materialization">
            <DetailPage />
          </RequirePermission>
        }
      />
      <Route path="datasets" element={<Datasets />} />
      <Route
        path="datasets/:name"
        element={
          <RequirePermission permission="datasets.view" what="datasets">
            <DatasetPage />
          </RequirePermission>
        }
      />
      <Route
        path="datasets/:name/:tab"
        element={
          <RequirePermission permission="datasets.view" what="datasets">
            <DatasetPage />
          </RequirePermission>
        }
      />
      <Route
        path="datasets/:name/tables/:table"
        element={
          <RequirePermission permission="datasets.view" what="datasets">
            <TablePage />
          </RequirePermission>
        }
      />
      <Route
        path="datasets/:name/tables/:table/:tab"
        element={
          <RequirePermission permission="datasets.view" what="datasets">
            <TablePage />
          </RequirePermission>
        }
      />
      <Route path="settings" element={<SettingsPage />} />
      <Route path="settings/:section" element={<SettingsPage />} />
      <Route path="settings/:section/:itemId" element={<SettingsPage />} />
      <Route path="*" element={<DomainHome />} />
    </Routes>
  );
}

function Overview(): ReactNode {
  return (
    <RequirePermission permission="materializations.view" what="the overview">
      <OverviewPage />
    </RequirePermission>
  );
}

function Materializations(): ReactNode {
  return (
    <RequirePermission permission="materializations.view" what="materializations">
      <MaterializationsPage />
    </RequirePermission>
  );
}

function Datasets(): ReactNode {
  return (
    <RequirePermission permission="datasets.view" what="datasets">
      <DatasetsPage />
    </RequirePermission>
  );
}

/** Explore: for anyone who may query a dataset, in any domain (docs/design/explore.md §8). */
function Explore(): ReactNode {
  return (
    <RequireDatasetPermission permission="data.query" what="exploring data">
      <Suspense
        fallback={
          <div className="flex min-h-[40vh] items-center justify-center">
            {/* The console itself is waiting, for the page's code: its mark flows (§10.7). */}
            <Mark size={32} working label="Loading" className="text-[var(--color-ink-faint)]" />
          </div>
        }
      >
        <ExplorePage />
      </Suspense>
    </RequireDatasetPermission>
  );
}

/** An address inside a domain that names no page: the domain's overview. */
function DomainHome(): ReactNode {
  const { id } = useDomain();
  return <Navigate to={domainPath(id)} replace />;
}

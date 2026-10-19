import { Center, Loader } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { createBrowserRouter, createRoutesFromElements, Navigate, Outlet, Route, RouterProvider, useLocation, useNavigate, useParams } from "react-router";
import { ModalsProvider } from "@mantine/modals";
import { Notifications } from "@mantine/notifications";
import { api, ApiError, setUnauthorizedHandler } from "./lib/api";
import { qk } from "./lib/queryKeys";
import { adminWs } from "./lib/ws";
import { dispatchWsInvalidation } from "./lib/wsInvalidation";
import { AppLayout } from "./layout/AppLayout";
import { PageSkeleton } from "./components/QueryBoundary";
import { MODULE_BY_KEY, moduleHref } from "./lib/meta";
import { loginPath } from "@/lib/loginRedirect";
import { PROFILE_ROUTE } from "./pages/ig/profile/links";

const LoginPage = lazy(() => import("./pages/login/LoginPage"));
const DashboardPage = lazy(() => import("./pages/dashboard/DashboardPage"));
const JobsPage = lazy(() => import("./pages/jobs/JobsPage"));
const JobDetailPage = lazy(() => import("./pages/jobs/JobDetailPage"));
const ModulePage = lazy(() => import("./pages/modules/ModulePage"));
const TerminologyPage = lazy(() => import("./pages/terminology/TerminologyPage"));
const IgPage = lazy(() => import("./pages/ig/IgPage"));
const ProfilePage = lazy(() => import("./pages/ig/profile/ProfilePage"));
const DrugPage = lazy(() => import("./pages/drug/DrugPage"));
const DrugExplorerPage = lazy(() => import("./pages/drug/DrugExplorerPage"));
const DrugDetailPage = lazy(() => import("./pages/drug/DrugDetailPage"));
const FhirServersPage = lazy(() => import("./pages/fhir/FhirServersPage"));
const FhirServerEditPage = lazy(() => import("./pages/fhir/FhirServerEditPage"));
const FhirServerDetailPage = lazy(() => import("./pages/fhir/FhirServerDetailPage"));
const ModelsPage = lazy(() => import("./pages/models/ModelsPage"));
const IntegrationsPage = lazy(() => import("./pages/integrations/IntegrationsPage"));
const McpPage = lazy(() => import("./pages/mcp/McpPage"));
const HealthPage = lazy(() => import("./pages/health/HealthPage"));
const SystemPage = lazy(() => import("./pages/system/SystemPage"));
const SecurityPage = lazy(() => import("./pages/security/SecurityPage"));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage"));

function FullScreenLoader() {
  return (
    <Center h="100dvh">
      <Loader />
    </Center>
  );
}

/** Gate the console on a valid session; start the live WebSocket once signed in. */
function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: qk.me, queryFn: () => api.get<{ username: string }>("/admin/api/me", { skipAuthRedirect: true }), retry: false, staleTime: Infinity });

  useEffect(() => {
    setUnauthorizedHandler(() => {
      qc.clear();
      const here = window.location.pathname.replace(/^\/admin/, "") + window.location.search;
      if (here.startsWith("/login")) return; // already there — don't nest another ?next=
      navigate(loginPath(here), { replace: true });
    });
  }, [navigate, qc]);

  useEffect(() => {
    if (!me.data) return;
    adminWs.start();
    return adminWs.subscribe((evt) => dispatchWsInvalidation(qc, evt));
  }, [me.data, qc]);

  if (me.isPending) return <FullScreenLoader />;
  if (me.isError) {
    if (me.error instanceof ApiError && me.error.status === 401) {
      return <Navigate to={loginPath(location.pathname + location.search)} replace />;
    }
    // Backend unreachable / misconfigured: still render the shell so the error is visible.
  }
  return <>{children}</>;
}

function Page({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PageSkeleton />}>{children}</Suspense>;
}

/**
 * Modals and toasts render inside the router so their content may use <Link>
 * and other router hooks (a toast linking to a new job crashed otherwise).
 */
function RootProviders() {
  return (
    <ModalsProvider labels={{ confirm: "確認", cancel: "取消" }}>
      <Notifications position="top-right" limit={4} zIndex={1000} />
      <Outlet />
    </ModalsProvider>
  );
}

/** Old `/data/<key>` URLs: terminologies and IG moved; TFDA sync modules stay here. */
function LegacyDataRoute() {
  const { moduleKey = "" } = useParams();
  const { search } = useLocation();
  const meta = MODULE_BY_KEY[moduleKey];
  if (meta && meta.group !== "tfda") return <Navigate to={moduleHref(moduleKey) + search} replace />;
  return (
    <Page>
      <ModulePage />
    </Page>
  );
}

const router = createBrowserRouter(
  createRoutesFromElements(
    <Route element={<RootProviders />}>
      <Route path="/login" element={<Suspense fallback={<FullScreenLoader />}><LoginPage /></Suspense>} />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<Page><DashboardPage /></Page>} />
        <Route path="jobs" element={<Page><JobsPage /></Page>} />
        <Route path="jobs/:jobId" element={<Page><JobDetailPage /></Page>} />
        <Route path="terminology" element={<Page><TerminologyPage /></Page>} />
        <Route path="terminology/:moduleKey" element={<Page><ModulePage /></Page>} />
        <Route path="fhir/ig" element={<Page><IgPage /></Page>} />
        <Route path={PROFILE_ROUTE} element={<Page><ProfilePage /></Page>} />
        <Route path="data/:moduleKey" element={<LegacyDataRoute />} />
        <Route path="drug" element={<Page><DrugPage /></Page>} />
        <Route path="drug/explorer" element={<Page><DrugExplorerPage /></Page>} />
        <Route path="drug/explorer/:licenseId" element={<Page><DrugDetailPage /></Page>} />
        <Route path="fhir-servers" element={<Page><FhirServersPage /></Page>} />
        <Route path="fhir-servers/new" element={<Page><FhirServerEditPage /></Page>} />
        <Route path="fhir-servers/:serverId" element={<Page><FhirServerDetailPage /></Page>} />
        <Route path="fhir-servers/:serverId/edit" element={<Page><FhirServerEditPage /></Page>} />
        <Route path="models" element={<Page><ModelsPage /></Page>} />
        <Route path="integrations" element={<Page><IntegrationsPage /></Page>} />
        <Route path="mcp" element={<Page><McpPage /></Page>} />
        <Route path="health" element={<Page><HealthPage /></Page>} />
        <Route path="system" element={<Page><SystemPage /></Page>} />
        <Route path="security" element={<Page><SecurityPage /></Page>} />
        <Route path="*" element={<Page><NotFoundPage /></Page>} />
      </Route>
    </Route>,
  ),
  { basename: "/admin" },
);

/** Data router (enables useBlocker for unsaved-change guards). */
export function App() {
  return <RouterProvider router={router} />;
}

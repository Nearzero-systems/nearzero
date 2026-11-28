import { ApiError } from "../api-error.ts";
import { ControlClient } from "../control-client.ts";
import type {
  AboutAddress,
  AllowedWorkspace,
  AutomaticCard,
  DatabaseConnection,
  DeploymentDetail,
  DeploymentLog,
  DeploymentPage,
  DeploymentView,
  DockerCleanup,
  DomainsOverview,
  EnvironmentDefaults,
  HostnameList,
  HostnameSuggestion,
  HostView,
  OperationsData,
  RecentDeployments,
  RouterFileList,
  ServerRecord,
  ServiceHostnames,
  ShareableVolume,
  SshKeyRecord,
  UploadedCertificate,
  WebhookView,
  ZoneList,
} from "./operations-types.ts";
import type { DataContext } from "./types.ts";

/**
 * Deployments, runtime, hostnames, DNS zones, certificates, servers, SSH keys and About
 * Nearzero's address from the control plane (docs/api/deploys.md, domains.md, servers.md), for
 * pages rendered on the server. Changes go from the browser through the console's /api/v1 proxy.
 */

const id = (value: string) => encodeURIComponent(value);

/** Not found, out of sight or refused becomes null; the console being cut off is thrown. */
async function orNull<T>(load: Promise<T>): Promise<T | null> {
  try {
    return await load;
  } catch (error) {
    if (error instanceof ApiError && (error.code === "not_found" || error.code === "forbidden")) {
      return null;
    }
    throw error;
  }
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function operationsData(ctx: DataContext): OperationsData {
  const api = new ControlClient(ctx);
  return {
    deployments(input) {
      return api.get<DeploymentPage>(
        `/deployments${query({
          search: input.search,
          status: input.status,
          type: input.type,
          page: input.page,
          pageSize: input.pageSize,
        })}`,
      );
    },
    async deployment(deploymentId) {
      const raw = await orNull(
        api.get<{ deployment: DeploymentDetail }>(`/deployments/${id(deploymentId)}`),
      );
      return raw?.deployment ?? null;
    },
    deploymentLog(deploymentId) {
      return orNull(api.get<DeploymentLog>(`/deployments/${id(deploymentId)}/log`));
    },
    async serviceDeployments(serviceId) {
      const raw = await orNull(
        api.get<{ deployments: DeploymentView[] }>(`/services/${id(serviceId)}/deployments`),
      );
      return raw?.deployments ?? [];
    },
    async recent(): Promise<RecentDeployments | null> {
      try {
        return await api.get<RecentDeployments>("/deployments/recent");
      } catch {
        return null;
      }
    },
    serviceHostnames(serviceId) {
      return orNull(api.get<ServiceHostnames>(`/services/${id(serviceId)}/hostnames`));
    },
    hostnameSuggestion(serviceId) {
      return orNull(api.get<HostnameSuggestion>(`/services/${id(serviceId)}/hostnames/suggestion`));
    },
    async connection(serviceId) {
      const raw = await orNull(
        api.get<{ connection: DatabaseConnection }>(`/services/${id(serviceId)}/connection`),
      );
      return raw?.connection ?? null;
    },
    webhook(serviceId) {
      return orNull(api.get<WebhookView>(`/services/${id(serviceId)}/webhook`));
    },
    async shareableVolumes(serviceId) {
      const raw = await orNull(
        api.get<{ volumes: ShareableVolume[] }>(`/services/${id(serviceId)}/shareable-volumes`),
      );
      return raw?.volumes ?? [];
    },
    async domains() {
      try {
        return await api.get<DomainsOverview>("/domains");
      } catch (error) {
        if (error instanceof ApiError && error.code === "forbidden") {
          return { refused: error.message };
        }
        throw error;
      }
    },
    hostnames(input) {
      return api.get<HostnameList>(`/domains/hostnames${query({ q: input.q, show: input.show })}`);
    },
    async automaticCard() {
      const raw = await orNull(api.get<{ card: AutomaticCard | null }>("/domains/automatic"));
      return raw?.card ?? null;
    },
    async zones() {
      return (
        (await orNull(api.get<ZoneList>("/domains/zones"))) ?? {
          zones: [],
          banner: null,
          canApplyAll: false,
        }
      );
    },
    async environmentDefaults() {
      return (
        (await orNull(api.get<EnvironmentDefaults>("/domains/defaults"))) ?? {
          defaults: [],
          options: [],
          prefixHint: "",
        }
      );
    },
    async certificates() {
      const raw = await orNull(
        api.get<{ certificates: UploadedCertificate[] }>("/domains/certificates"),
      );
      return raw?.certificates ?? [];
    },
    async servers(input) {
      const raw = await api.get<{ servers: ServerRecord[] }>(
        `/servers${query({ q: input.q, status: input.status })}`,
      );
      return raw.servers;
    },
    async sshKeys() {
      const raw = await orNull(api.get<{ keys: SshKeyRecord[] }>("/ssh-keys"));
      return raw?.keys ?? null;
    },
    async host() {
      const raw = await orNull(api.get<{ host: HostView }>("/host"));
      return raw?.host ?? null;
    },
    async allowedWorkspaces() {
      const raw = await orNull(
        api.get<{ workspaces: AllowedWorkspace[] }>("/host/allowed-workspaces"),
      );
      return raw?.workspaces ?? null;
    },
    async routerFiles(targetId) {
      return api.get<RouterFileList>(`/servers/${id(targetId)}/router-files`);
    },
    async dockerCleanup(serverId) {
      const raw = await orNull(
        api.get<{ cleanup: DockerCleanup }>(`/servers/${id(serverId)}/docker-cleanup`),
      );
      return raw?.cleanup ?? null;
    },
    about() {
      return api.get<AboutAddress>("/about/address");
    },
    async health() {
      try {
        return await api.get<{ version: string }>("/health");
      } catch {
        return null;
      }
    },
  };
}

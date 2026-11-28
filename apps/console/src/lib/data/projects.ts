import { ApiError } from "../api-error.ts";
import { ControlClient } from "../control-client.ts";
import { startDeploy } from "../deploys.ts";
import type {
  DataContext,
  EnvironmentVariablesView,
  EnvironmentView,
  ProjectData,
  ProjectList,
  ProjectView,
  ServerBrief,
  ServerTarget,
  ServiceDetail,
  ServiceVariablesView,
  ServiceView,
} from "./types.ts";

/**
 * Projects, environments, services and variables from the control plane's projects API
 * (docs/api/projects.md), for pages rendered on the server. Changes people make in dialogs go
 * from the browser to /api/v1 through the console's proxy (client/api.ts); forms that post to
 * the page itself (create and update a project) come through here.
 */

type Dated<T> = Omit<T, "createdAt" | "updatedAt"> & { createdAt: string; updatedAt?: string };

const id = (value: string) => encodeURIComponent(value);

function projectFrom(raw: Dated<ProjectView>): ProjectView {
  return {
    ...raw,
    createdAt: new Date(raw.createdAt),
    updatedAt: new Date(raw.updatedAt ?? raw.createdAt),
  };
}

function environmentFrom(raw: Dated<EnvironmentView>): EnvironmentView {
  const { updatedAt: _updated, ...rest } = raw;
  return { ...rest, createdAt: new Date(raw.createdAt) };
}

function serviceFrom<T extends ServiceView>(raw: Dated<T>): T {
  const { updatedAt: _updated, ...rest } = raw;
  return { ...rest, createdAt: new Date(raw.createdAt) } as unknown as T;
}

/** Not found (or out of sight, which looks the same) becomes null; anything else is thrown. */
async function orNull<T>(load: Promise<T>): Promise<T | null> {
  try {
    return await load;
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") return null;
    throw error;
  }
}

export function projectsData(ctx: DataContext): ProjectData {
  const api = new ControlClient(ctx);

  return {
    async projects(sort) {
      const query = sort ? `?sort=${id(sort)}` : "";
      const raw = await api.get<Omit<ProjectList, "projects"> & { projects: Dated<ProjectView>[] }>(
        `/projects${query}`,
      );
      return {
        projects: raw.projects.map(projectFrom),
        total: raw.total,
        matching: raw.matching,
        can: raw.can,
      };
    },
    async project(projectId) {
      const raw = await orNull(
        api.get<{ project: Dated<ProjectView> }>(`/projects/${id(projectId)}`),
      );
      return raw ? projectFrom(raw.project) : null;
    },
    async createProject(input) {
      const raw = await api.post<{
        project: Dated<ProjectView>;
        environmentId: string;
        message: string;
      }>("/projects", input);
      return { ...raw, project: projectFrom(raw.project) };
    },
    async updateProject(projectId, input) {
      await api.patch(`/projects/${id(projectId)}`, input);
    },
    async environments(projectId) {
      const raw = await api.get<{
        environments: Dated<EnvironmentView>[];
        can: { create: boolean };
      }>(`/projects/${id(projectId)}/environments`);
      return { list: raw.environments.map(environmentFrom), canCreate: raw.can.create };
    },
    async services(environmentId) {
      const raw = await api.get<{ services: Dated<ServiceView>[]; can: { create: boolean } }>(
        `/environments/${id(environmentId)}/services`,
      );
      return {
        list: raw.services.map((service) => serviceFrom<ServiceView>(service)),
        canCreate: raw.can.create,
      };
    },
    async service(serviceId) {
      const raw = await orNull(
        api.get<{ service: Dated<ServiceDetail> }>(`/services/${id(serviceId)}`),
      );
      return raw ? serviceFrom<ServiceDetail>(raw.service) : null;
    },
    async environmentVariables(environmentId): Promise<EnvironmentVariablesView> {
      try {
        const raw = await api.get<
          Omit<Extract<EnvironmentVariablesView, { readable: true }>, "readable">
        >(`/environments/${id(environmentId)}/variables`);
        return { readable: true, ...raw };
      } catch (error) {
        // Without read rights the API refuses with the words to show (spec 05 5.5).
        if (error instanceof ApiError && error.code === "forbidden") {
          return { readable: false, message: error.message };
        }
        throw error;
      }
    },
    serviceVariables(serviceId) {
      return api.get<ServiceVariablesView>(`/services/${id(serviceId)}/variables`);
    },
    async targets() {
      try {
        return (await api.get<{ targets: ServerTarget[] }>("/servers/targets")).targets;
      } catch (error) {
        if (error instanceof ApiError && error.code === "control_unreachable") throw error;
        return [];
      }
    },
    async server(serverId): Promise<ServerBrief | null> {
      if (serverId === "host") return { id: "host", name: "Nearzero host", address: null };
      const raw = await orNull(
        api.get<{ server: { id: string; name: string; address: string } }>(
          `/servers/${id(serverId)}`,
        ),
      ).catch(() => null);
      if (!raw) return null;
      return { id: raw.server.id, name: raw.server.name, address: raw.server.address || null };
    },
    deploy(serviceId) {
      const send = <T>(method: string, path: string, body?: unknown): Promise<T> => {
        if (method === "POST") return api.post<T>(path, body);
        if (method === "PUT") return api.put<T>(path, body);
        if (method === "PATCH") return api.patch<T>(path, body);
        if (method === "DELETE") return api.delete<T>(path);
        return api.get<T>(path);
      };
      return startDeploy(send, serviceId);
    },
  };
}

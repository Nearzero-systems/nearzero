import { asApiError, callApi, formBody, refreshPage, sendForm } from "./api.ts";
import { showToast } from "./toasts.ts";

/**
 * The Source panel's provider tabs in the browser (spec 6.3, 7.2): repository and branch
 * suggestions from the chosen account, watch paths typed and entered, saving the source (then
 * the deploy when the person may deploy), "Disconnect repository", and registering the push
 * webhook again.
 */

let suggestTimer: number | undefined;
let ticket = 0;

function tabOf(element: Element | null): HTMLElement | null {
  return element?.closest<HTMLElement>("[data-git-source-tab]") ?? null;
}

function fill(list: HTMLDataListElement | null, values: string[]): void {
  list?.replaceChildren(
    ...values.map((value) => {
      const option = document.createElement("option");
      option.value = value;
      return option;
    }),
  );
}

async function suggestRepositories(form: HTMLFormElement): Promise<void> {
  const account = form.querySelector<HTMLSelectElement>("[data-git-source-account]")?.value;
  const search = form.querySelector<HTMLInputElement>("[data-git-source-repo]")?.value.trim() ?? "";
  if (!account) return;
  const mine = ++ticket;
  try {
    const answer = await callApi<{ repositories: { fullName: string }[] }>(
      "GET",
      `/git-providers/${encodeURIComponent(account)}/repositories?search=${encodeURIComponent(search)}`,
    );
    if (mine !== ticket) return;
    fill(
      form.querySelector<HTMLDataListElement>("[data-git-source-repos]"),
      answer.repositories.map((item) => item.fullName),
    );
  } catch {
    // Suggestions are a help only; typing owner/name still works.
  }
}

async function suggestBranches(form: HTMLFormElement): Promise<void> {
  const account = form.querySelector<HTMLSelectElement>("[data-git-source-account]")?.value;
  const repository = form.querySelector<HTMLInputElement>("[data-git-source-repo]")?.value.trim();
  if (!account || !repository?.includes("/")) return;
  try {
    const answer = await callApi<{ branches: { name: string }[]; defaultBranch: string | null }>(
      "GET",
      `/git-providers/${encodeURIComponent(account)}/branches?repository=${encodeURIComponent(repository)}`,
    );
    fill(
      form.querySelector<HTMLDataListElement>("[data-git-source-branches]"),
      answer.branches.map((item) => item.name),
    );
    const branch = form.querySelector<HTMLInputElement>("[data-git-source-branch]");
    if (branch && !branch.value && answer.defaultBranch) branch.value = answer.defaultBranch;
  } catch {
    // The save checks the repository and says what is wrong.
  }
}

function watchPaths(form: HTMLFormElement): string[] {
  return Array.from(form.querySelectorAll<HTMLElement>("[data-git-watch-path]")).map(
    (chip) => chip.dataset.gitWatchPath ?? "",
  );
}

function addWatchPath(input: HTMLInputElement): void {
  const form = input.closest<HTMLFormElement>("form");
  const list = form?.querySelector<HTMLElement>("[data-git-watch-list]");
  const path = input.value.trim();
  if (!form || !list || !path) return;
  if (!watchPaths(form).includes(path)) {
    const chip = document.createElement("span");
    chip.className = "nz-git-chip";
    chip.dataset.gitWatchPath = path;
    chip.append(path);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.dataset.gitWatchRemove = "";
    remove.setAttribute("aria-label", `Remove ${path}`);
    remove.textContent = "×";
    chip.append(remove);
    list.append(chip);
  }
  input.value = "";
}

async function simple(method: string, path: string, fallback: string): Promise<void> {
  try {
    const answer = await callApi<{ message?: string; push?: { message?: string } }>(method, path);
    showToast(answer.message ?? answer.push?.message ?? fallback, { tone: "success" });
    await refreshPage();
  } catch (error) {
    showToast(asApiError(error).message, { tone: "error", persist: true });
  }
}

export function initGitSource(): void {
  document.addEventListener("keydown", (event) => {
    const target = event.target as HTMLInputElement | null;
    if (event.key !== "Enter" || !target?.matches?.("[data-git-watch-input]")) return;
    event.preventDefault();
    addWatchPath(target);
  });

  document.addEventListener("input", (event) => {
    const target = event.target as HTMLElement | null;
    if (!tabOf(target) || !target?.matches("[data-git-source-repo]")) return;
    const form = target.closest<HTMLFormElement>("form");
    window.clearTimeout(suggestTimer);
    if (form) suggestTimer = window.setTimeout(() => void suggestRepositories(form), 250);
  });

  document.addEventListener("change", (event) => {
    const target = event.target as HTMLElement | null;
    if (!tabOf(target)) return;
    const form = target?.closest<HTMLFormElement>("form");
    if (!form) return;
    if (target?.matches("[data-git-source-account]")) void suggestRepositories(form);
    if (target?.matches("[data-git-source-repo]")) void suggestBranches(form);
  });

  document.addEventListener(
    "focusin",
    (event) => {
      const target = event.target as HTMLElement | null;
      if (!target?.matches?.("[data-git-source-repo]")) return;
      const form = target.closest<HTMLFormElement>("form");
      const list = form?.querySelector<HTMLDataListElement>("[data-git-source-repos]");
      if (form && list && list.children.length === 0) void suggestRepositories(form);
    },
    true,
  );

  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const remove = target?.closest<HTMLElement>("[data-git-watch-remove]");
    if (remove && tabOf(remove)) {
      remove.closest("[data-git-watch-path]")?.remove();
      return;
    }
    const disconnect = target?.closest<HTMLElement>("[data-git-disconnect]");
    if (disconnect) {
      void simple(
        "DELETE",
        `/services/${encodeURIComponent(disconnect.dataset.gitDisconnect ?? "")}/git-source`,
        "Repository disconnected",
      );
      return;
    }
    const register = target?.closest<HTMLElement>("[data-git-register]");
    if (register) {
      void simple(
        "POST",
        `/services/${encodeURIComponent(register.dataset.gitRegister ?? "")}/git-source/webhook`,
        "Webhook registered",
      );
    }
  });

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches("[data-git-source-form]")) return;
    event.preventDefault();
    if (form.hasAttribute("data-busy")) return;
    // Text left in the watch path box counts, as if Enter was pressed.
    const pending = form.querySelector<HTMLInputElement>("[data-git-watch-input]");
    if (pending?.value.trim()) addWatchPath(pending);
    const body = formBody(form);
    body.watchPaths = watchPaths(form);
    void sendForm(form, body);
  });

  document.addEventListener("nz:api-success", (event) => {
    const form = event.target as HTMLElement | null;
    if (!form?.matches?.("[data-git-source-form]")) return;
    const answer = (event as CustomEvent).detail as {
      notes?: string[];
      push?: { status?: string; message?: string };
    };
    for (const note of answer?.notes ?? []) showToast(note, { tone: "info" });
    if (answer?.push?.message && answer.push.status !== "automatic") {
      showToast(answer.push.message, {
        tone: answer.push.status === "registered" ? "success" : "info",
        persist: answer.push.status !== "registered",
      });
    }
  });
}

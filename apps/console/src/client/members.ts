import type { Capability } from "@nearzero/shared";
import { emptyScope, grantSources } from "../lib/access-tree.ts";
import { browserCopyEnvironment, COPIED_MESSAGE, copyText } from "../lib/copy-text.ts";
import type { AccessScope, MemberAccess } from "../lib/data/types.ts";
import { generatePassword } from "../lib/passwords.ts";
import { fillEditor, readEditor, showSources } from "./access-editor.ts";
import {
  asApiError,
  callApi,
  clearErrors,
  formBody,
  refreshPage,
  showErrors,
  showFormError,
} from "./api.ts";
import { openDialog } from "./dialogs.ts";
import { showToast } from "./toasts.ts";

/**
 * Settings → Members & access (spec 04 4.7): the People filter, Add user (invite or set a
 * password) and its results, invitation links and resends, a member's access with "From
 * <policy>" marks, the policy dialog, and the invitation emails dialog.
 */

interface PolicyData {
  id: string;
  name: string;
  description: string;
  capabilities: Capability[];
  scope: AccessScope;
}

interface Delivery {
  emailed: boolean;
  reason?: string;
  link: string;
}

function policies(): PolicyData[] {
  const raw = document.getElementById("nz-policies-data")?.textContent ?? "[]";
  try {
    return JSON.parse(raw) as PolicyData[];
  } catch {
    return [];
  }
}

function dialog(id: string): HTMLDialogElement | null {
  const element = document.getElementById(id);
  return element instanceof HTMLDialogElement ? element : null;
}

// ---------- People filter and tabs

function filterPeople(input: HTMLInputElement): void {
  const root = input.closest<HTMLElement>("[data-people]");
  if (!root) return;
  const query = input.value.trim().toLowerCase();
  let shown = 0;
  for (const row of root.querySelectorAll<HTMLElement>("[data-people-row]")) {
    const match = !query || (row.dataset.search ?? "").includes(query);
    row.hidden = !match;
    if (match) shown++;
  }
  const none = root.querySelector<HTMLElement>("[data-people-no-match]");
  if (none) none.hidden = shown > 0 || !query;
}

// ---------- Invitation links

function openLinkDialog(link: string, text: string, opener?: Element | null): void {
  const box = dialog("nz-invitation-link");
  if (!box) return;
  const url = box.querySelector<HTMLElement>("[data-invitation-link-url]");
  if (url) {
    url.textContent = link;
    url.title = link;
  }
  const copy = box.querySelector<HTMLElement>("[data-invitation-link-copy]");
  if (copy) copy.dataset.copy = link;
  const note = box.querySelector<HTMLElement>("[data-invitation-link-text]");
  if (note) note.textContent = text;
  openDialog(box, opener);
}

async function copyInvitationLink(button: HTMLElement): Promise<void> {
  const id = button.dataset.invitationCopy ?? "";
  const email = button.dataset.invitationEmail ?? "";
  try {
    const { link } = await callApi<{ link: string }>(
      "GET",
      `/workspace/invitations/${encodeURIComponent(id)}/link`,
    );
    if (await copyText(link, browserCopyEnvironment())) {
      showToast(COPIED_MESSAGE, { tone: "success" });
    } else {
      openLinkDialog(link, `Send this link to ${email}.`, button);
    }
  } catch (error) {
    showToast(asApiError(error).message, { tone: "error" });
  }
}

async function resendInvitation(button: HTMLElement): Promise<void> {
  const id = button.dataset.invitationResend ?? "";
  const email = button.dataset.invitationEmail ?? "";
  button.setAttribute("aria-disabled", "true");
  try {
    const { delivery } = await callApi<{ delivery: Delivery }>(
      "POST",
      `/workspace/invitations/${encodeURIComponent(id)}/resend`,
    );
    if (delivery.emailed) {
      showToast(`Emailed to ${email}.`, { tone: "success" });
      await refreshPage();
    } else {
      // Not emailed: the link dialog opens instead (spec 04 4.5).
      openLinkDialog(
        delivery.link,
        delivery.reason ?? `Not emailed. Send this link to ${email} yourself.`,
        button,
      );
      dialog("nz-invitation-link")?.setAttribute("data-refresh-on-close", "");
    }
  } catch (error) {
    showToast(asApiError(error).message, { tone: "error" });
  } finally {
    button.removeAttribute("aria-disabled");
  }
}

// ---------- Add user

function addRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-add-user]");
}

function syncAddUser(root: HTMLElement): void {
  const form = root.querySelector<HTMLFormElement>("[data-add-user-form]");
  if (!form) return;
  const mode =
    form.querySelector<HTMLInputElement>("[data-add-mode]:checked")?.value === "password"
      ? "password"
      : "invite";
  const role = form.querySelector<HTMLInputElement>("[data-add-role]:checked")?.value ?? "member";
  const password = form.querySelector<HTMLElement>("[data-add-password]");
  if (password) password.hidden = mode !== "password";
  const note = form.querySelector<HTMLElement>("[data-add-invite-only]");
  if (note) note.hidden = mode === "password";
  // Policies are for members only; the API refuses them for admins.
  const policyBox = form.querySelector<HTMLElement>("[data-add-policies]");
  if (policyBox) policyBox.hidden = role !== "member";
  const submit = form.querySelector<HTMLElement>("[data-add-submit]");
  if (submit)
    submit.textContent =
      mode === "password" ? "Add user" : (root.dataset.inviteLabel ?? "Send invitation");
}

function resultField(label: string, value: string, secret = false): HTMLElement {
  const row = document.createElement("div");
  row.className = "nz-result-field";
  const name = document.createElement("span");
  name.className = "nz-dim";
  name.textContent = label;
  const text = document.createElement("code");
  text.className = "nz-url-text";
  text.textContent = value;
  if (secret) text.dataset.secret = "";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "nz-btn nz-btn--outline";
  copy.dataset.copy = value;
  copy.setAttribute("aria-label", `Copy ${label.toLowerCase()}`);
  copy.textContent = "Copy";
  row.append(name, text, copy);
  return row;
}

function showAddResult(
  root: HTMLElement,
  input: { title: string; text: string; fields: HTMLElement[] },
): void {
  const form = root.querySelector<HTMLFormElement>("[data-add-user-form]");
  const result = root.querySelector<HTMLElement>("[data-add-result]");
  if (!form || !result) return;
  form.hidden = true;
  result.hidden = false;
  const title = result.querySelector<HTMLElement>("[data-add-result-title]");
  if (title) title.textContent = input.title;
  const text = result.querySelector<HTMLElement>("[data-add-result-text]");
  if (text) text.textContent = input.text;
  result.querySelector<HTMLElement>("[data-add-result-fields]")?.replaceChildren(...input.fields);
  root.closest("dialog")?.setAttribute("data-refresh-on-close", "");
  result.querySelector<HTMLElement>("[data-dialog-close]")?.focus();
}

function resetAddUser(root: HTMLElement): void {
  const form = root.querySelector<HTMLFormElement>("[data-add-user-form]");
  const result = root.querySelector<HTMLElement>("[data-add-result]");
  if (form) {
    form.reset();
    clearErrors(form);
    form.hidden = false;
  }
  if (result) result.hidden = true;
  const password = root.querySelector<HTMLInputElement>("#nz-add-user-password");
  if (password) password.type = "password";
  syncAddUser(root);
}

async function submitAddUser(form: HTMLFormElement): Promise<void> {
  const root = addRoot();
  if (!root) return;
  const body = formBody(form) as {
    mode?: string;
    email: string;
    role: string;
    policyIds?: string[];
    password?: string;
  };
  const mode = body.mode === "password" ? "password" : "invite";
  const payload: Record<string, unknown> = {
    email: body.email,
    role: body.role,
    policyIds: body.role === "member" ? (body.policyIds ?? []) : [],
  };
  form.setAttribute("data-busy", "");
  try {
    if (mode === "password") {
      payload.password = body.password ?? "";
      const answer = await callApi<{ signIn: { address: string; email: string } }>(
        "POST",
        "/workspace/members",
        payload,
      );
      showAddResult(root, {
        title: `${answer.signIn.email} can sign in now`,
        text: "Send them these sign-in details. They finish their profile when they first sign in.",
        fields: [
          resultField("Address", answer.signIn.address),
          resultField("Email", answer.signIn.email),
          resultField("Password", String(payload.password), true),
        ],
      });
      return;
    }
    const answer = await callApi<{ delivery: Delivery }>("POST", "/workspace/invitations", payload);
    const { delivery } = answer;
    showAddResult(root, {
      title: delivery.emailed
        ? `Emailed to ${body.email}.`
        : `Invitation created for ${body.email}`,
      text: delivery.emailed
        ? "They can also use this link. It works only for their address and lasts 7 days."
        : (delivery.reason ?? "Not emailed: email isn't set up for this workspace or this server."),
      fields: [resultField("Link", delivery.link)],
    });
  } catch (error) {
    showErrors(form, asApiError(error));
  } finally {
    form.removeAttribute("data-busy");
    for (const button of form.querySelectorAll('button[type="submit"]'))
      button.removeAttribute("aria-disabled");
  }
}

// ---------- A member's access

let accessTarget: { personId: string; name: string } | null = null;

function accessForm(): HTMLFormElement | null {
  return document.querySelector<HTMLFormElement>("[data-member-access-form]");
}

function updateSources(form: HTMLFormElement): void {
  const attached = new Set(
    Array.from(form.querySelectorAll<HTMLInputElement>("[data-access-policy]"))
      .filter((input) => input.checked)
      .map((input) => input.value),
  );
  const editor = form.querySelector<HTMLElement>("[data-access-editor]");
  if (editor) showSources(editor, grantSources(policies(), attached));
}

async function openMemberAccess(trigger: HTMLElement): Promise<void> {
  const box = dialog("nz-member-access");
  const form = accessForm();
  if (!box || !form) return;
  const personId = trigger.dataset.memberAccess ?? "";
  const name = trigger.dataset.memberName ?? "";
  accessTarget = { personId, name };
  trigger.closest<HTMLElement>("[popover]")?.hidePopover();
  const title = box.querySelector<HTMLElement>(".nz-dialog-title");
  if (title) title.textContent = `Access for ${name}`;
  const field = form.querySelector<HTMLInputElement>('[name="personId"]');
  if (field) field.value = personId;
  const loading = form.querySelector<HTMLElement>("[data-access-loading]");
  const body = form.querySelector<HTMLElement>("[data-access-body]");
  const save = form.querySelector<HTMLButtonElement>("[data-access-save]");
  if (loading) {
    loading.hidden = false;
    loading.textContent = "Loading their access…";
  }
  if (body) body.hidden = true;
  if (save) save.disabled = true;
  clearErrors(form);
  openDialog(box, trigger);
  try {
    const access = await callApi<MemberAccess>(
      "GET",
      `/workspace/members/${encodeURIComponent(personId)}/access`,
    );
    if (accessTarget?.personId !== personId) return;
    const attached = new Set(access.policies.map((policy) => policy.id));
    for (const input of form.querySelectorAll<HTMLInputElement>("[data-access-policy]")) {
      input.checked = attached.has(input.value);
    }
    const editor = form.querySelector<HTMLElement>("[data-access-editor]");
    if (editor) fillEditor(editor, access.direct);
    updateSources(form);
    if (loading) loading.hidden = true;
    if (body) body.hidden = false;
    if (save) save.disabled = false;
    form.querySelector<HTMLElement>("[data-access-policy], [data-capability]")?.focus();
  } catch (error) {
    if (loading) loading.hidden = true;
    showFormError(form, asApiError(error).message);
  }
}

async function saveMemberAccess(form: HTMLFormElement): Promise<void> {
  if (!accessTarget) return;
  const editor = form.querySelector<HTMLElement>("[data-access-editor]");
  if (!editor) return;
  const grants = readEditor(editor);
  const policyIds = Array.from(form.querySelectorAll<HTMLInputElement>("[data-access-policy]"))
    .filter((input) => input.checked)
    .map((input) => input.value);
  form.setAttribute("data-busy", "");
  try {
    await callApi("PUT", `/workspace/members/${encodeURIComponent(accessTarget.personId)}/access`, {
      policyIds,
      capabilities: grants.capabilities,
      scope: grants.scope,
    });
    showToast(`Access saved for ${accessTarget.name}`, { tone: "success" });
    form.closest("dialog")?.close();
    await refreshPage();
  } catch (error) {
    showErrors(form, asApiError(error));
  } finally {
    form.removeAttribute("data-busy");
    for (const button of form.querySelectorAll('button[type="submit"]'))
      button.removeAttribute("aria-disabled");
  }
}

// ---------- Policies

const DEVELOPERS_EXAMPLE: Omit<PolicyData, "id"> = {
  name: "Developers",
  description: "Builds and deploys the team's apps.",
  capabilities: [
    "projects.create",
    "environments.create",
    "services.create",
    "git.connect-own",
    "ssh-keys.use",
  ],
  scope: { ...emptyScope(), allServers: true },
};

function openPolicy(trigger: HTMLElement, policy: Omit<PolicyData, "id"> & { id?: string }): void {
  const box = dialog("nz-policy");
  const form = box?.querySelector<HTMLFormElement>("[data-policy-form]");
  if (!box || !form) return;
  form.reset();
  clearErrors(form);
  const title = box.querySelector<HTMLElement>(".nz-dialog-title");
  if (title) title.textContent = policy.id ? `Edit ${policy.name}` : "New policy";
  const set = (name: string, value: string) => {
    const field = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`);
    if (field) field.value = value;
  };
  set("policyId", policy.id ?? "");
  set("name", policy.name);
  set("description", policy.description);
  const editor = form.querySelector<HTMLElement>("[data-access-editor]");
  if (editor) fillEditor(editor, { capabilities: policy.capabilities, scope: policy.scope });
  openDialog(box, trigger);
}

async function savePolicy(form: HTMLFormElement): Promise<void> {
  const editor = form.querySelector<HTMLElement>("[data-access-editor]");
  if (!editor) return;
  const fields = formBody(form) as { policyId?: string; name: string; description: string };
  const grants = readEditor(editor);
  const body = {
    name: fields.name,
    description: fields.description,
    capabilities: grants.capabilities,
    scope: grants.scope,
  };
  form.setAttribute("data-busy", "");
  try {
    if (fields.policyId) {
      await callApi("PUT", `/workspace/policies/${encodeURIComponent(fields.policyId)}`, body);
    } else {
      await callApi("POST", "/workspace/policies", body);
    }
    showToast(fields.policyId ? "Policy saved" : "Policy created", { tone: "success" });
    form.closest("dialog")?.close();
    const url = new URL(location.href);
    url.searchParams.set("tab", "policies");
    history.replaceState(history.state, "", url);
    await refreshPage();
  } catch (error) {
    showErrors(form, asApiError(error));
  } finally {
    form.removeAttribute("data-busy");
    for (const button of form.querySelectorAll('button[type="submit"]'))
      button.removeAttribute("aria-disabled");
  }
}

// ---------- Wiring

export function initMembers(): void {
  document.addEventListener("input", (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement && input.matches("[data-people-filter]")) {
      filterPeople(input);
    }
  });

  document.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (input.matches("[data-add-mode], [data-add-role]")) {
      const root = addRoot();
      if (root) syncAddUser(root);
    } else if (input.matches("[data-access-policy]")) {
      const form = input.closest<HTMLFormElement>("form");
      if (form) updateSources(form);
    } else if (input.matches("[data-email-provider]")) {
      const form = input.closest<HTMLFormElement>("form");
      for (const section of form?.querySelectorAll<HTMLElement>("[data-provider-fields]") ?? []) {
        section.hidden = section.dataset.providerFields !== input.value;
      }
    }
  });

  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (!target) return;
    const copy = target.closest<HTMLElement>("[data-invitation-copy]");
    if (copy) {
      void copyInvitationLink(copy);
      return;
    }
    const resend = target.closest<HTMLElement>("[data-invitation-resend]");
    if (resend) {
      void resendInvitation(resend);
      return;
    }
    const access = target.closest<HTMLElement>("[data-member-access]");
    if (access) {
      event.preventDefault();
      void openMemberAccess(access);
      return;
    }
    const show = target.closest<HTMLElement>("[data-password-show]");
    if (show) {
      const input = document.querySelector<HTMLInputElement>("#nz-add-user-password");
      if (input) {
        const visible = input.type === "password";
        input.type = visible ? "text" : "password";
        show.setAttribute("aria-pressed", visible ? "true" : "false");
        const label = show.querySelector<HTMLElement>("[data-password-show-label]");
        if (label) label.textContent = visible ? "Hide" : "Show";
      }
      return;
    }
    if (target.closest("[data-password-generate]")) {
      const input = document.querySelector<HTMLInputElement>("#nz-add-user-password");
      if (input) {
        input.value = generatePassword((count) => crypto.getRandomValues(new Uint8Array(count)));
        input.type = "text";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return;
    }
    if (target.closest("[data-add-another]")) {
      const root = addRoot();
      if (root) {
        resetAddUser(root);
        root.querySelector<HTMLElement>("#nz-add-user-email")?.focus();
      }
      return;
    }
    const newPolicy = target.closest<HTMLElement>("[data-policy-new]");
    if (newPolicy) {
      openPolicy(newPolicy, { name: "", description: "", capabilities: [], scope: emptyScope() });
      return;
    }
    const example = target.closest<HTMLElement>("[data-policy-example]");
    if (example) {
      openPolicy(example, DEVELOPERS_EXAMPLE);
      return;
    }
    const edit = target.closest<HTMLElement>("[data-policy-edit]");
    if (edit) {
      const found = policies().find((policy) => policy.id === edit.dataset.policyEdit);
      if (found) openPolicy(edit, found);
      return;
    }
    // Remembers the tab in the address, so reloading after a change stays on it.
    const tab = target.closest<HTMLElement>('#nz-members-tabs [role="tab"]');
    if (tab) {
      const url = new URL(location.href);
      if (tab.id.endsWith("-policies")) url.searchParams.set("tab", "policies");
      else url.searchParams.delete("tab");
      history.replaceState(history.state, "", url);
    }
  });

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.matches("[data-add-user-form]")) {
      event.preventDefault();
      if (!form.hasAttribute("data-busy")) void submitAddUser(form);
    } else if (form.matches("[data-member-access-form]")) {
      event.preventDefault();
      if (!form.hasAttribute("data-busy")) void saveMemberAccess(form);
    } else if (form.matches("[data-policy-form]")) {
      event.preventDefault();
      if (!form.hasAttribute("data-busy")) void savePolicy(form);
    }
  });

  // The email dialog: a saved setting whose test failed is still saved, but says so.
  document.addEventListener("nz:api-success", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || form.dataset.apiThen !== "email") return;
    const answer = (event as CustomEvent<{ testSent?: boolean; message?: string }>).detail ?? {};
    showToast(answer.message ?? "Saved.", {
      tone: answer.testSent === false ? "error" : "success",
      persist: answer.testSent === false,
    });
    form.closest("dialog")?.close();
    void refreshPage();
  });

  // Dialogs that showed a result reload the page's lists when they close.
  document.addEventListener(
    "close",
    (event) => {
      const box = event.target;
      if (!(box instanceof HTMLDialogElement)) return;
      if (box.id === "nz-member-access") accessTarget = null;
      if (box.id === "nz-add-user") {
        const root = addRoot();
        if (root) resetAddUser(root);
      }
      if (box.hasAttribute("data-refresh-on-close")) {
        box.removeAttribute("data-refresh-on-close");
        void refreshPage();
      }
    },
    true,
  );

  document.addEventListener("astro:page-load", () => {
    const root = addRoot();
    if (root) syncAddUser(root);
    const filter = document.querySelector<HTMLInputElement>("[data-people-filter]");
    if (filter?.value) filterPeople(filter);
  });
}

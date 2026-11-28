import { BACKUP_CODES_COPIED, backupCodesFileName, backupCodesText } from "../lib/backup-codes.ts";
import { asApiError, callApi, clearErrors, refreshPage, showErrors } from "./api.ts";
import { showToast } from "./toasts.ts";

/**
 * The Enable and Manage two-factor dialogs (spec 4.6). The password typed in the first step is
 * kept only in memory while the dialog is open, and forgotten when it closes. QR code images
 * come from the server as SVG (no crypto or QR code library in the browser, spec 21.9).
 */

interface SetupAnswer {
  secret: string;
  otpauthUri: string;
  qrSvg: string;
  backupCodes: string[];
}

const passwords = new WeakMap<HTMLElement, string>();

function step(root: HTMLElement, name: string): void {
  for (const panel of root.querySelectorAll<HTMLElement>("[data-2fa-step]")) {
    panel.hidden = panel.dataset["2faStep"] !== name;
  }
  const next = root.querySelector<HTMLElement>(`[data-2fa-step="${name}"]`);
  next?.querySelector<HTMLElement>("input:not([type=hidden]), button")?.focus();
}

function showCodes(root: HTMLElement, codes: string[]): void {
  for (const list of root.querySelectorAll<HTMLElement>("[data-2fa-codes]")) {
    list.replaceChildren(
      ...codes.map((code) => {
        const item = document.createElement("li");
        item.textContent = code;
        return item;
      }),
    );
  }
  // Download and Copy give the same text: heading, notes, account, date and numbered codes.
  const made = new Date();
  const text = backupCodesText(root.dataset.email ?? "", codes, made);
  for (const button of root.querySelectorAll<HTMLElement>("[data-2fa-copy-codes]")) {
    button.dataset.copy = text;
    button.dataset.copyMessage = BACKUP_CODES_COPIED;
  }
  root.dataset.codes = text;
  root.dataset.codesMade = String(made.getTime());
}

function download(root: HTMLElement): void {
  const text = root.dataset.codes ?? "";
  const made = new Date(Number(root.dataset.codesMade ?? Date.now()));
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = backupCodesFileName(made);
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function reset(root: HTMLElement): void {
  passwords.delete(root);
  delete root.dataset.codes;
  delete root.dataset.codesMade;
  for (const form of root.querySelectorAll<HTMLFormElement>("form")) {
    form.reset();
    clearErrors(form);
    setBusy(form, false);
  }
  for (const list of root.querySelectorAll<HTMLElement>("[data-2fa-codes]")) list.replaceChildren();
  const qr = root.querySelector<HTMLImageElement>("[data-2fa-qr]");
  qr?.removeAttribute("src");
  const confirm = root.querySelector<HTMLElement>("[data-2fa-disable-confirm]");
  if (confirm) confirm.hidden = true;
  step(root, "password");
}

/** One answer at a time; the button is usable again once the answer or a refusal is back. */
function setBusy(form: HTMLFormElement, busy: boolean): void {
  form.toggleAttribute("data-busy", busy);
  for (const button of form.querySelectorAll<HTMLButtonElement>('button[type="submit"]')) {
    if (busy) button.setAttribute("aria-disabled", "true");
    else button.removeAttribute("aria-disabled");
  }
}

async function onSubmit(form: HTMLFormElement): Promise<void> {
  const root = form.closest<HTMLElement>("[data-2fa-enable], [data-2fa-manage]");
  if (!root || form.hasAttribute("data-busy")) return;
  const data = new FormData(form);
  setBusy(form, true);
  try {
    if (root.matches("[data-2fa-enable]") && form.dataset["2faStep"] === "password") {
      const password = String(data.get("password") ?? "");
      const issuer = String(data.get("issuer") ?? "").trim();
      const answer = await callApi<SetupAnswer>("POST", "/me/two-factor/setup", {
        password,
        ...(issuer ? { issuer } : {}),
      });
      const qr = root.querySelector<HTMLImageElement>("[data-2fa-qr]");
      if (qr) qr.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(answer.qrSvg)}`;
      const secret = root.querySelector<HTMLElement>("[data-2fa-secret]");
      if (secret) secret.textContent = answer.secret;
      const copySecret = root.querySelector<HTMLElement>("[data-2fa-copy-secret]");
      if (copySecret) copySecret.dataset.copy = answer.secret;
      showCodes(root, answer.backupCodes);
      step(root, "setup");
      root.querySelector<HTMLInputElement>("#nz-2fa-enable-code")?.focus();
      return;
    }
    if (form.dataset["2faStepForm"] === "enable") {
      const answer = await callApi<{ message?: string }>("POST", "/me/two-factor/enable", {
        code: String(data.get("code") ?? "").trim(),
      });
      showToast(answer.message ?? "2FA configured successfully", { tone: "success" });
      root.closest("dialog")?.close();
      await refreshPage();
      return;
    }
    if (root.matches("[data-2fa-manage]") && form.dataset["2faStep"] === "password") {
      const password = String(data.get("password") ?? "");
      await callApi("POST", "/me/two-factor/verify-password", { password });
      passwords.set(root, password);
      step(root, "choose");
    }
  } catch (error) {
    showErrors(form, asApiError(error));
  } finally {
    setBusy(form, false);
  }
}

async function manageAction(button: HTMLElement): Promise<void> {
  const root = button.closest<HTMLElement>("[data-2fa-manage]");
  if (!root) return;
  const panel = root.querySelector<HTMLElement>('[data-2fa-step="choose"]');
  const password = passwords.get(root);
  if (!password) {
    step(root, "password");
    return;
  }
  const fail = (error: unknown) => {
    const problem = asApiError(error);
    const slot = panel?.querySelector<HTMLElement>("[data-form-error]");
    const text = slot?.querySelector<HTMLElement>("[data-form-error-text]");
    if (slot && text) {
      text.textContent = problem.message;
      slot.hidden = false;
    } else showToast(problem.message, { tone: "error" });
  };
  button.setAttribute("aria-disabled", "true");
  try {
    if (button.matches("[data-2fa-regenerate]")) {
      const answer = await callApi<{ backupCodes: string[] }>(
        "POST",
        "/me/two-factor/backup-codes",
        {
          password,
        },
      );
      showCodes(root, answer.backupCodes);
      step(root, "codes");
      root.dataset.refreshOnClose = "true";
      showToast("Backup codes regenerated successfully", { tone: "success" });
    } else if (button.matches("[data-2fa-disable]")) {
      await callApi("POST", "/me/two-factor/disable", { password });
      showToast("2FA disabled successfully", { tone: "success" });
      root.closest("dialog")?.close();
      await refreshPage();
    }
  } catch (error) {
    fail(error);
  } finally {
    button.removeAttribute("aria-disabled");
  }
}

export function initTwoFactor(): void {
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.closest("[data-2fa-enable], [data-2fa-manage]"))
      return;
    event.preventDefault();
    void onSubmit(form);
  });

  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const root = target?.closest<HTMLElement>("[data-2fa-enable], [data-2fa-manage]");
    if (!root) return;
    if (target?.closest("[data-2fa-download]")) {
      download(root);
      return;
    }
    const confirm = root.querySelector<HTMLElement>("[data-2fa-disable-confirm]");
    if (target?.closest("[data-2fa-disable-ask]") && confirm) {
      confirm.hidden = false;
      confirm.querySelector<HTMLElement>("[data-2fa-disable]")?.focus();
      return;
    }
    if (target?.closest("[data-2fa-disable-cancel]") && confirm) {
      confirm.hidden = true;
      return;
    }
    const action = target?.closest<HTMLElement>("[data-2fa-regenerate], [data-2fa-disable]");
    if (action) void manageAction(action);
  });

  // Closing forgets the password and the codes; a dialog that changed codes reloads the page.
  document.addEventListener(
    "close",
    (event) => {
      const dialog = event.target;
      if (!(dialog instanceof HTMLDialogElement)) return;
      const root = dialog.querySelector<HTMLElement>("[data-2fa-enable], [data-2fa-manage]");
      if (!root) return;
      const refresh = root.dataset.refreshOnClose === "true";
      delete root.dataset.refreshOnClose;
      reset(root);
      if (refresh) void refreshPage();
    },
    true,
  );
}

import { avatarProblem, initialsTextColor } from "../lib/avatar.ts";
import {
  asApiError,
  callApi,
  clearErrors,
  formBody,
  refreshPage,
  showErrors,
  showFormError,
} from "./api.ts";
import { showToast } from "./toasts.ts";

/**
 * The Profile page (spec 4.6, 21.10): one form whose Save sends only what changed: the names and
 * the avatar (PATCH /me), then a new email (with the current password), then a new password.
 * Each refusal shows under its field. Choosing an image uploads it at once (under 2 MB, PNG,
 * JPEG, GIF or WebP), which also makes it the avatar; "Remove image" goes back to initials. The
 * palette opens the initials' colors, and any color comes from the picker beside them.
 */

/** Every account's starting color; its initials draw as the neutral circle. */
const NEUTRAL = "violet";

function fieldError(form: HTMLFormElement, name: string, message: string): void {
  const input = form.querySelector<HTMLInputElement>(`[name="${name}"]`);
  const slot = input?.closest("[data-field]")?.querySelector<HTMLElement>("[data-field-error]");
  if (!input || !slot) {
    showFormError(form, message);
    return;
  }
  input.setAttribute("aria-invalid", "true");
  slot.textContent = message;
  slot.hidden = false;
  input.focus();
}

/** The initials circle follows the chosen color before it is saved. */
function paintInitials(form: HTMLFormElement, color: string): void {
  const face = form.querySelector<HTMLElement>("[data-avatar-initials]");
  if (!face) return;
  face.removeAttribute("style");
  if (/^#[0-9a-f]{6}$/.test(color)) {
    face.dataset.color = "custom";
    face.style.background = color;
    face.style.color = initialsTextColor(color);
  } else if (color === NEUTRAL) {
    delete face.dataset.color;
  } else {
    face.dataset.color = color;
  }
}

async function save(form: HTMLFormElement): Promise<void> {
  const body = formBody(form);
  const saved = form.dataset;
  const text = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : "");
  const profile: Record<string, string> = {};
  if (text("firstName") !== (saved.firstName ?? "")) profile.firstName = text("firstName");
  if (text("lastName") !== (saved.lastName ?? "")) profile.lastName = text("lastName");
  // An image becomes the avatar when it uploads; Save only switches between the others.
  const kind = text("avatarKind");
  if (kind && kind !== "image" && kind !== saved.avatarKind) profile.avatarKind = kind;
  const color = text("avatarColor");
  if (color && color !== saved.avatarColor) profile.avatarColor = color;
  const email = text("email");
  const emailChanged = email.toLowerCase() !== (saved.email ?? "").toLowerCase();
  const currentPassword = text("currentPassword");
  const newPassword = text("newPassword");

  clearErrors(form);
  if ((emailChanged || newPassword) && !currentPassword) {
    fieldError(form, "currentPassword", "Enter your current password.");
    return;
  }
  if (Object.keys(profile).length === 0 && !emailChanged && !newPassword) {
    showToast("Nothing to change.", { tone: "info" });
    return;
  }

  const done: string[] = [];
  try {
    if (Object.keys(profile).length > 0) {
      await callApi("PATCH", "/me", profile);
      if (profile.firstName !== undefined) saved.firstName = profile.firstName;
      if (profile.lastName !== undefined) saved.lastName = profile.lastName;
      if (profile.avatarKind !== undefined) saved.avatarKind = profile.avatarKind;
      if (profile.avatarColor !== undefined) saved.avatarColor = profile.avatarColor;
      done.push("Profile updated.");
    }
    if (emailChanged) {
      // The new address counts once its link is opened; the old one stays until then (R1-02).
      const asked = await callApi<{ message: string }>("POST", "/me/email", {
        email,
        currentPassword,
      });
      done.push(asked.message);
    }
    if (newPassword) {
      await callApi("POST", "/me/password", { currentPassword, newPassword });
      done.push("Password changed. Your other sessions were signed out.");
    }
  } catch (error) {
    if (done.length > 0) showToast(done.join(" "), { tone: "success" });
    showErrors(form, asApiError(error));
    return;
  }
  showToast(done.join(" "), { tone: "success" });
  await refreshPage();
}

export function initProfile(): void {
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches("[data-profile-form]")) return;
    event.preventDefault();
    if (form.hasAttribute("data-busy")) return;
    form.toggleAttribute("data-busy", true);
    void save(form).finally(() => {
      form.toggleAttribute("data-busy", false);
      for (const button of form.querySelectorAll('button[type="submit"]')) {
        button.removeAttribute("aria-disabled");
      }
    });
  });

  document.addEventListener("change", async (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.matches("[data-avatar-file]")) return;
    const form = input.closest<HTMLFormElement>("form");
    const file = input.files?.[0];
    if (!form || !file) return;
    const problem = avatarProblem(file, Number(input.dataset.maxBytes ?? 2 * 1024 * 1024));
    if (problem) {
      showFormError(form, problem);
      input.value = "";
      return;
    }
    try {
      const answer = await callApi<{ message?: string }>("PUT", "/me/avatar", undefined, {
        raw: file,
        contentType: file.type,
      });
      showToast(answer.message ?? "Profile updated", { tone: "success" });
      await refreshPage();
    } catch (error) {
      showFormError(form, asApiError(error).message);
    } finally {
      input.value = "";
    }
  });

  // Confirming the address (spec 4.6, 30a R1-02): send the link (again), or take a change back.
  document.addEventListener("click", async (event) => {
    const target = event.target as Element | null;
    const send = target?.closest<HTMLButtonElement>("[data-email-send-link]");
    const cancel = target?.closest<HTMLButtonElement>("[data-email-cancel-change]");
    const button = send ?? cancel;
    if (!button || button.getAttribute("aria-disabled") === "true") return;
    const form = button.closest<HTMLFormElement>("form");
    button.setAttribute("aria-disabled", "true");
    try {
      if (send) {
        const answer = await callApi<{ message: string }>("POST", "/me/email/confirmation");
        showToast(answer.message, { tone: "success" });
      } else {
        await callApi("DELETE", "/me/email/change");
        showToast("Email change cancelled.", { tone: "success" });
        await refreshPage();
      }
    } catch (error) {
      if (form) showFormError(form, asApiError(error).message);
    } finally {
      button.removeAttribute("aria-disabled");
    }
  });

  document.addEventListener("click", async (event) => {
    const target = event.target as Element | null;
    const palette = target?.closest<HTMLButtonElement>("[data-avatar-palette]");
    if (palette) {
      const panel = document.getElementById(palette.getAttribute("aria-controls") ?? "");
      if (!panel) return;
      // Closed by an attribute, not `hidden`: a color chosen before closing is still sent.
      const open = panel.dataset.open !== "true";
      panel.dataset.open = String(open);
      palette.setAttribute("aria-expanded", String(open));
      if (open) panel.querySelector<HTMLInputElement>("input:checked")?.focus();
      return;
    }
    const button = target?.closest<HTMLElement>("[data-avatar-remove]");
    if (!button) return;
    const form = button.closest<HTMLFormElement>("form");
    try {
      const answer = await callApi<{ message?: string }>("DELETE", "/me/avatar");
      showToast(answer.message ?? "Profile updated", { tone: "success" });
      await refreshPage();
    } catch (error) {
      if (form) showFormError(form, asApiError(error).message);
    }
  });

  // A color for the initials chooses the initials too, and shows on the circle at once.
  document.addEventListener("change", (event) => {
    const radio = event.target;
    if (!(radio instanceof HTMLInputElement) || radio.name !== "avatarColor") return;
    const form = radio.closest<HTMLFormElement>("[data-profile-form]");
    if (!form) return;
    const initials = form.querySelector<HTMLInputElement>(
      'input[name="avatarKind"][value="initials"]',
    );
    if (initials) initials.checked = true;
    paintInitials(form, radio.value);
  });

  // Any color (spec 4.6): the picker fills the custom swatch and chooses it.
  document.addEventListener("input", (event) => {
    const picker = event.target;
    if (!(picker instanceof HTMLInputElement) || !picker.matches("[data-avatar-custom]")) return;
    const form = picker.closest<HTMLFormElement>("form");
    const swatch = form?.querySelector<HTMLElement>("[data-avatar-custom-swatch]");
    const radio = form?.querySelector<HTMLInputElement>("[data-avatar-custom-radio]");
    if (!form || !swatch || !radio) return;
    const color = picker.value.toLowerCase();
    radio.value = color;
    radio.checked = true;
    swatch.style.background = color;
    swatch.dataset.chosen = "true";
    const initials = form.querySelector<HTMLInputElement>(
      'input[name="avatarKind"][value="initials"]',
    );
    if (initials) initials.checked = true;
    paintInitials(form, color);
  });

  // Picking the image circle with nothing uploaded opens the file picker.
  document.addEventListener("change", (event) => {
    const radio = event.target;
    if (!(radio instanceof HTMLInputElement) || !radio.matches("[data-avatar-image]")) return;
    if (radio.defaultChecked) return;
    radio.closest("form")?.querySelector<HTMLInputElement>("[data-avatar-file]")?.click();
  });
}

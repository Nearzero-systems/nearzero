import { MASK } from "../lib/connection.ts";
import {
  browserCopyEnvironment,
  COPIED_MESSAGE,
  COPY_REFUSED_MESSAGE,
  copyText,
} from "../lib/copy-text.ts";
import type { DatabaseConnection } from "../lib/data/operations-types.ts";
import type { DatabaseCredentials } from "../lib/data/types.ts";
import { asApiError, callApi } from "./api.ts";
import { showToast } from "./toasts.ts";

/**
 * The database Connection card (spec 08 8.2): "Show password" asks the API for the full URLs
 * (POST …/connection/reveal) and the credentials (POST …/credentials/reveal) and shows them;
 * Copy fetches them first when needed, so a copied URL always works. Nothing secret is fetched
 * until someone asks, and hiding puts the masked text the page came with back.
 */

interface Revealed {
  connection: DatabaseConnection;
  credentials: DatabaseCredentials;
}

const cache = new WeakMap<HTMLElement, Revealed>();
const masked = new WeakMap<HTMLElement, string>();

async function reveal(card: HTMLElement): Promise<Revealed> {
  const known = cache.get(card);
  if (known) return known;
  const id = encodeURIComponent(card.dataset.serviceId ?? "");
  const [{ connection }, { credentials }] = await Promise.all([
    callApi<{ connection: DatabaseConnection }>("POST", `/services/${id}/connection/reveal`),
    callApi<{ credentials: DatabaseCredentials }>("POST", `/services/${id}/credentials/reveal`),
  ]);
  const revealed = { connection, credentials };
  cache.set(card, revealed);
  return revealed;
}

function paint(card: HTMLElement, shown: Revealed | null): void {
  for (const element of card.querySelectorAll<HTMLElement>("[data-conn-url]")) {
    if (!masked.has(element)) masked.set(element, element.textContent ?? "");
    const scope = element.dataset.connUrl as "public" | "internal";
    element.textContent = shown
      ? ((scope === "public" ? shown.connection.public.url : shown.connection.internal.url) ?? "")
      : (masked.get(element) ?? "");
  }
  for (const element of card.querySelectorAll<HTMLElement>("[data-conn-secret]")) {
    const key = element.dataset.connSecret as "password" | "rootPassword";
    element.textContent = shown ? (shown.credentials[key] ?? "") : MASK;
  }
  for (const button of card.querySelectorAll<HTMLElement>("[data-conn-reveal]")) {
    button.setAttribute("aria-pressed", shown ? "true" : "false");
    const label = button.querySelector<HTMLElement>("[data-conn-reveal-label]");
    if (label) label.textContent = shown ? "Hide password" : "Show password";
    const name = button.getAttribute("aria-label");
    if (name)
      button.setAttribute(
        "aria-label",
        `${shown ? "Hide" : "Show"} ${name.replace(/^(Show|Hide) /, "")}`,
      );
  }
  card.dataset.revealed = shown ? "true" : "false";
}

async function toggle(card: HTMLElement): Promise<void> {
  if (card.dataset.revealed === "true") {
    paint(card, null);
    return;
  }
  try {
    paint(card, await reveal(card));
  } catch (error) {
    showToast(asApiError(error).message, { tone: "error" });
  }
}

async function copy(card: HTMLElement, what: string): Promise<void> {
  let shown: Revealed;
  try {
    shown = await reveal(card);
  } catch (error) {
    showToast(asApiError(error).message, { tone: "error" });
    return;
  }
  const text =
    what === "password"
      ? shown.credentials.password
      : what === "rootPassword"
        ? (shown.credentials.rootPassword ?? "")
        : what === "public"
          ? (shown.connection.public.url ?? "")
          : shown.connection.internal.url;
  const ok = await copyText(text, browserCopyEnvironment());
  showToast(ok ? COPIED_MESSAGE : COPY_REFUSED_MESSAGE, { tone: ok ? "success" : "error" });
}

export function initConnectionCards(): void {
  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const card = target?.closest<HTMLElement>("[data-connection]");
    if (!card) return;
    if (target?.closest("[data-conn-reveal]")) {
      event.preventDefault();
      void toggle(card);
      return;
    }
    const copier = target?.closest<HTMLElement>("[data-conn-copy]");
    if (copier && event.isTrusted) {
      event.preventDefault();
      void copy(card, copier.dataset.connCopy ?? "");
    }
  });
}

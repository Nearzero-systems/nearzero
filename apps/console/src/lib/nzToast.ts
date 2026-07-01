/** CustomEvent name for {@link NearzeroToastHost}. */
export const NZ_TOAST_EVENT = "nz-toast";
export const NZ_TOAST_ACTION_EVENT = "nz-toast-action";

export type NzToastAction = {
  id: string;
  label: string;
  tone?: "default" | "primary" | "danger";
};

export type NzToastDetail = {
  message: string;
  description?: string;
  persistent?: boolean;
  toastId?: string;
  actions?: NzToastAction[];
  /** Optional tone for non-React toast hosts (e.g. dashboard vanilla script). */
  variant?: "default" | "success" | "error";
};

export type NzToastInput = string | NzToastDetail;
export type NzToastActionDetail = {
  toastId?: string;
  actionId: string;
};

/**
 * Show the global bottom-right toast (Framer Motion host on Dashboard / Base layouts).
 * Safe from inline scripts and React islands.
 */
export function showNearzeroToast(input: NzToastInput): void {
  if (typeof document === "undefined") return;
  const detail: NzToastDetail =
    typeof input === "string"
      ? { message: String(input || "").trim() }
      : {
          message: String(input?.message || "").trim(),
          description: String(input?.description || "").trim() || undefined,
          persistent: Boolean(input?.persistent),
          toastId: String(input?.toastId || "").trim() || undefined,
          actions: Array.isArray(input?.actions)
            ? input.actions
                .map((action) => ({
                  id: String(action?.id || "").trim(),
                  label: String(action?.label || "").trim(),
                  tone:
                    action?.tone === "primary" || action?.tone === "danger"
                      ? action.tone
                      : ("default" as const),
                }))
                .filter((action) => action.id && action.label)
            : undefined,
        };
  if (!detail.message) return;
  document.dispatchEvent(
    new CustomEvent<NzToastDetail>(NZ_TOAST_EVENT, {
      bubbles: true,
      detail,
    }),
  );
}

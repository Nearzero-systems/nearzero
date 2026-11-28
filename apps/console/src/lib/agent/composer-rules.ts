import {
  type AttachmentKind,
  attachmentSizeProblem,
  attachmentTotalProblem,
  classifyAttachment,
} from "@nearzero/shared/browser";

/**
 * The message box's rules (spec 19.3, 19.10): which keys send, how attachments are checked
 * before they upload, how images are shrunk, and how many uploads run at once.
 */

export interface KeyLike {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey?: boolean;
  isComposing?: boolean;
}

/**
 * On a computer Enter sends and Shift+Enter adds a line; on a phone (a coarse pointer) Return
 * adds a line and only the send button sends. Ctrl/Cmd+Enter sends everywhere.
 */
export function enterSends(event: KeyLike, phone: boolean): boolean {
  if (event.key !== "Enter" || event.isComposing) return false;
  if (event.metaKey || event.ctrlKey) return true;
  if (phone || event.shiftKey || event.altKey) return false;
  return true;
}

/** The box grows to about 8 lines, then scrolls. */
export const COMPOSER_MAX_LINES = 8;

export function composerHeight(scrollHeight: number, lineHeight = 16, padding = 4): number {
  return Math.min(scrollHeight, COMPOSER_MAX_LINES * lineHeight + padding);
}

export interface AttachmentLimits {
  filesPerMessage: number;
  totalBytes: number;
  perKind: Record<AttachmentKind, number>;
  concurrentUploads: number;
}

export type FileCheck =
  | { ok: true; kind: AttachmentKind; contentType: string }
  | { ok: false; reason: string };

/** A file before it uploads: refused kinds with their reason, sizes per kind. */
export function checkFile(
  file: { name: string; type: string; size: number },
  limits: Pick<AttachmentLimits, "perKind">,
): FileCheck {
  const kind = classifyAttachment(file.name, file.type);
  if (!kind.ok) return kind;
  const max = limits.perKind[kind.kind];
  const problem =
    file.size > max
      ? attachmentSizeProblem(kind.kind, file.size)
      : file.size <= 0
        ? "This file is empty."
        : null;
  if (problem) return { ok: false, reason: problem };
  return kind;
}

/** Whether one more file fits the message: at most 10, at most the total size together. */
export function addProblem(
  current: readonly { sizeBytes: number; failed: boolean }[],
  size: number,
  limits: Pick<AttachmentLimits, "filesPerMessage" | "totalBytes">,
): string | null {
  const kept = current.filter((item) => !item.failed);
  if (kept.length >= limits.filesPerMessage) {
    return `Attach up to ${limits.filesPerMessage} files per message.`;
  }
  const total = kept.reduce((sum, item) => sum + item.sizeBytes, 0) + size;
  return attachmentTotalProblem(total, limits.totalBytes);
}

export const IMAGE_MAX_SIDE = 2_048;

/** The size an image is drawn at before upload: 2,048px on the long side at most. */
export function shrunkSize(
  width: number,
  height: number,
  maxSide = IMAGE_MAX_SIDE,
): { width: number; height: number; changed: boolean } {
  const long = Math.max(width, height);
  if (long <= maxSide || long <= 0) return { width, height, changed: false };
  const scale = maxSide / long;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    changed: true,
  };
}

/** Images the browser redraws smaller (animated GIFs would lose their frames, so not those). */
export function shrinkable(contentType: string): boolean {
  return /^image\/(png|jpeg|webp)$/.test(contentType);
}

/** Which queued uploads may start now: at most `limit` running at once, in order. */
export function uploadsToStart(
  items: readonly { id: string; state: "queued" | "uploading" | "done" | "failed" }[],
  limit: number,
): string[] {
  const running = items.filter((item) => item.state === "uploading").length;
  const free = Math.max(0, limit - running);
  return items
    .filter((item) => item.state === "queued")
    .slice(0, free)
    .map((item) => item.id);
}

/** The send button: what it does now. */
export function sendState(input: {
  hasContent: boolean;
  working: boolean;
  uploading: boolean;
  readOnly: boolean;
  disabled: boolean;
}): "send" | "stop" | "wait" | "off" {
  if (input.working) return "stop";
  if (input.readOnly || input.disabled || !input.hasContent) return "off";
  if (input.uploading) return "wait";
  return "send";
}

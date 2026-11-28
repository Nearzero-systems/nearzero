import { AGENT_MESSAGES, sessionTitleProblem } from "@nearzero/shared/browser";
import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { canStartDrag, dropIndex, moveIndex, passedThreshold } from "../../lib/agent/ordering.ts";
import type { SessionView } from "../../lib/agent/types.ts";
import { fullDate, pastTime, shortPastTime } from "../../lib/time.ts";
import { Icon, useAgent, useStore } from "./context.tsx";
import { usePresence } from "./motion.tsx";

/**
 * The sessions list (spec 19.5): "New session" on top, then up to 50 of the person's sessions
 * (a working indicator, the title, the time of the last message), each with a ⋯ menu (Rename,
 * Move up, Move down, Share with workspace, Delete…), rename by double-click, dragging to
 * reorder, and every failure in a line under "New session". Sessions others shared follow.
 */

const DELETE_WORDS = (title: string) =>
  `Delete "${title}"? Its messages and files are deleted. This can't be undone.`;

function titleOf(session: SessionView): string {
  return session.title?.trim() || AGENT_MESSAGES.untitled;
}

/** Starts at the time of the first paint (so hydration matches), then follows the clock. */
function useNow(): Date {
  const renderedAt = useAgent((state) => state.renderedAt);
  const [now, setNow] = useState(() => new Date(renderedAt));
  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

interface MenuProps {
  session: SessionView;
  index: number;
  count: number;
  runningHere: boolean;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
  anchor: DOMRect;
  /** Fading out after it closed (spec 21.7): drawn, but it takes no keys or clicks. */
  leaving: boolean;
  outer: RefObject<HTMLDivElement | null>;
}

function RowMenu({
  session,
  index,
  count,
  runningHere,
  onRename,
  onDelete,
  onClose,
  anchor,
  leaving,
  outer,
}: MenuProps) {
  const store = useStore();
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{
    left: number;
    top: number;
    side: "top" | "bottom";
  } | null>(null);

  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const viewportWidth = document.documentElement.clientWidth;
    let left = anchor.right - width;
    left = Math.min(Math.max(8, left), Math.max(8, viewportWidth - width - 8));
    let top = anchor.bottom + 4;
    if (top + height > window.innerHeight - 8) top = Math.max(8, anchor.top - 4 - height);
    setPlace({ left, top, side: top < anchor.top ? "top" : "bottom" });
    element.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [anchor]);

  useEffect(() => {
    if (leaving) return;
    const away = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose, leaving]);

  const onKey = (event: KeyboardEvent) => {
    const items = Array.from(
      menu.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([aria-disabled="true"])',
      ) ?? [],
    );
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(at + 1) % items.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(at - 1 + items.length) % items.length]?.focus();
    } else if (event.key === "Tab") {
      onClose();
    }
  };

  const item = (
    label: string,
    icon: Parameters<typeof Icon>[0]["name"],
    run: () => void,
    options: { disabled?: boolean; title?: string; danger?: boolean } = {},
  ) => (
    <button
      type="button"
      role="menuitem"
      className={`nz-menu-item${options.danger ? " nz-menu-item--danger" : ""}`}
      aria-disabled={options.disabled ? "true" : undefined}
      title={options.title}
      onClick={() => {
        if (options.disabled) return;
        onClose();
        run();
      }}
    >
      <Icon name={icon} />
      {label}
    </button>
  );

  // On the page itself: a fixed box inside the glass column would be placed against that column.
  return createPortal(
    <div
      ref={(node) => {
        menu.current = node;
        outer.current = node;
      }}
      role="menu"
      aria-label={`${titleOf(session)} actions`}
      className="nz-pop nz-session-menu"
      data-side={place?.side}
      data-motion={leaving ? "out" : undefined}
      inert={leaving}
      style={{ position: "fixed", left: place?.left ?? -9999, top: place?.top ?? -9999 }}
      onKeyDown={onKey}
    >
      {item("Rename", "edit", onRename)}
      {item("Move up", "arrow-up", () => void store.move(session.id, -1), {
        disabled: index === 0,
      })}
      {item("Move down", "chevron-down", () => void store.move(session.id, 1), {
        disabled: index >= count - 1,
      })}
      {item(
        session.shared ? "Stop sharing" : "Share with workspace",
        "users",
        () => void store.share(session.id, !session.shared),
      )}
      <hr className="nz-menu-sep" />
      {item("Delete…", "trash", onDelete, {
        danger: true,
        disabled: runningHere,
        title: runningHere ? AGENT_MESSAGES.stopToDelete : undefined,
      })}
    </div>,
    document.body,
  );
}

interface RowProps {
  session: SessionView;
  index: number;
  count: number;
  current: boolean;
  runningHere: boolean;
  mine: boolean;
  dragging: boolean;
  offset: number;
  onPointerDown: (event: ReactPointerEvent, index: number, onGrip: boolean) => void;
}

function SessionRow({
  session,
  index,
  count,
  current,
  runningHere,
  mine,
  dragging,
  offset,
  onPointerDown,
}: RowProps) {
  const store = useStore();
  const workspace = useAgent((state) => state.workspace);
  const now = useNow();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  // The menu stays for its fade out, where it was opened (spec 21.7).
  const presence = usePresence<HTMLDivElement>(menu !== null);
  const lastAnchor = useRef<DOMRect | null>(null);
  if (menu) lastAnchor.current = menu;
  const input = useRef<HTMLInputElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const title = titleOf(session);
  const href = `/${workspace}/dashboard/agent?session=${encodeURIComponent(session.id)}`;
  const working = session.state !== "idle";
  const time = session.lastMessageAt ? new Date(session.lastMessageAt) : null;

  useLayoutEffect(() => {
    if (renaming) input.current?.select();
  }, [renaming]);

  // The delete confirm takes focus on its Cancel button, and Escape cancels it wherever focus
  // is (spec 19.5, as rename does), handing focus back to the row's ⋯ button.
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!confirming) return;
    cancelButton.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || deleting) return;
      event.preventDefault();
      event.stopPropagation();
      setConfirming(false);
      menuButton.current?.focus();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [confirming, deleting]);

  const startRename = () => {
    if (!mine) return;
    setDraft(session.title ?? "");
    setRenameError(null);
    setRenaming(true);
  };

  const saveRename = async () => {
    const clean = draft.replace(/\s+/g, " ").trim();
    if (clean === (session.title ?? "").trim()) {
      setRenaming(false);
      return;
    }
    const problem = sessionTitleProblem(clean);
    if (problem) {
      setRenameError(problem);
      input.current?.focus();
      return;
    }
    const refusal = await store.rename(session.id, clean);
    if (refusal) {
      setRenameError(refusal);
      input.current?.focus();
      return;
    }
    setRenaming(false);
  };

  return (
    <li
      className="nz-session"
      data-session={session.id}
      data-dragging={dragging ? "true" : "false"}
      style={dragging ? { transform: `translateY(${offset}px)` } : undefined}
    >
      {renaming ? (
        <div className="nz-session-rename">
          <input
            ref={input}
            className="nz-input"
            aria-label="Session name"
            value={draft}
            maxLength={200}
            aria-invalid={renameError ? "true" : undefined}
            onChange={(event) => {
              setDraft(event.target.value.replace(/[\r\n]+/g, " "));
              setRenameError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void saveRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setRenaming(false);
              }
            }}
            onBlur={() => void saveRename()}
          />
          {renameError && <p className="nz-field-error">{renameError}</p>}
        </div>
      ) : (
        <div
          className="nz-session-row"
          aria-current={current ? "page" : undefined}
          onPointerDown={(event) => {
            if (mine)
              onPointerDown(
                event,
                index,
                (event.target as Element).closest(".nz-session-grip") !== null,
              );
          }}
        >
          {mine && (
            <span className="nz-session-grip" aria-hidden="true" title="Drag to reorder">
              <svg viewBox="0 0 24 24" width={12} height={12} aria-hidden="true">
                <circle cx="9" cy="7" r="1.4" fill="currentColor" />
                <circle cx="15" cy="7" r="1.4" fill="currentColor" />
                <circle cx="9" cy="12" r="1.4" fill="currentColor" />
                <circle cx="15" cy="12" r="1.4" fill="currentColor" />
                <circle cx="9" cy="17" r="1.4" fill="currentColor" />
                <circle cx="15" cy="17" r="1.4" fill="currentColor" />
              </svg>
            </span>
          )}
          <a
            href={href}
            className="nz-session-link"
            data-prefetch="false"
            draggable={false}
            onMouseEnter={() => store.preload(session.id)}
            onFocus={() => store.preload(session.id)}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
              event.preventDefault();
              void store.openSession(session.id);
            }}
            onDoubleClick={(event) => {
              event.preventDefault();
              startRename();
            }}
          >
            {working && (
              <span
                className="nz-session-working"
                role="img"
                aria-label={session.state === "waiting" ? "Waiting for you" : "Working"}
              />
            )}
            <span className="nz-session-title">{title}</span>
            {time && (
              <span
                className="nz-session-time nz-small"
                title={`${pastTime(time, now)} · ${fullDate(time)}`}
              >
                <span aria-hidden="true" data-session-time>
                  {shortPastTime(time, now)}
                </span>
                <span className="nz-visually-hidden">{pastTime(time, now)}</span>
              </span>
            )}
          </a>
          {mine && (
            <button
              ref={menuButton}
              type="button"
              className="nz-btn nz-btn--icon nz-session-more"
              aria-label={`${title} actions`}
              aria-haspopup="menu"
              aria-expanded={menu !== null}
              onClick={() =>
                setMenu(menu ? null : (menuButton.current?.getBoundingClientRect() ?? null))
              }
            >
              <Icon name="more" />
            </button>
          )}
        </div>
      )}
      {presence.mounted && lastAnchor.current && (
        <RowMenu
          session={session}
          index={index}
          count={count}
          runningHere={runningHere}
          anchor={menu ?? lastAnchor.current}
          leaving={presence.leaving}
          outer={presence.ref}
          onRename={startRename}
          onDelete={() => setConfirming(true)}
          onClose={() => {
            setMenu(null);
            menuButton.current?.focus();
          }}
        />
      )}
      {confirming && (
        <div className="nz-session-confirm" role="alertdialog" aria-label="Delete session">
          <p>{DELETE_WORDS(title)}</p>
          <div className="nz-session-confirm-actions">
            <button
              ref={cancelButton}
              type="button"
              className="nz-btn nz-btn--outline"
              onClick={() => {
                setConfirming(false);
                menuButton.current?.focus();
              }}
              disabled={deleting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="nz-btn nz-btn--danger"
              disabled={deleting || runningHere}
              title={runningHere ? AGENT_MESSAGES.stopToDelete : undefined}
              onClick={async () => {
                setDeleting(true);
                const gone = await store.remove(session.id);
                setDeleting(false);
                if (gone) setConfirming(false);
              }}
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
          </div>
          {runningHere && <p className="nz-hint">{AGENT_MESSAGES.stopToDelete}</p>}
        </div>
      )}
    </li>
  );
}

interface Drag {
  pointerId: number;
  from: number;
  startY: number;
  startX: number;
  active: boolean;
  y: number;
  middles: number[];
  heights: number[];
}

export function SessionsPanel({ variant }: { variant: "column" | "sheet" }) {
  const store = useStore();
  const sessions = useAgent((state) => state.sessions);
  const shared = useAgent((state) => state.shared);
  const currentId = useAgent((state) => state.chat.id);
  const listError = useAgent((state) => state.listError);
  const liveHere = useAgent((state) => {
    const last = state.chat.turns.at(-1);
    return last?.live && (last.state === "working" || last.state === "waiting")
      ? state.chat.id
      : null;
  });
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const shown = sessions.slice(0, 50);

  dragRef.current = drag;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const dragging = drag !== null;

  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current || event.pointerId !== current.pointerId) return;
      if (!current.active) {
        if (!passedThreshold(event.clientX - current.startX, event.clientY - current.startY))
          return;
        setDrag({ ...current, active: true, y: event.clientY });
        return;
      }
      event.preventDefault();
      setDrag({ ...current, y: event.clientY });
    };
    const up = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current || event.pointerId !== current.pointerId) return;
      setDrag(null);
      if (!current.active) return;
      // The click that ends a drag doesn't open the session under the pointer.
      const swallow = (click: MouseEvent) => {
        click.preventDefault();
        click.stopPropagation();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      const to = dropIndex(event.clientY, current.middles, current.from);
      if (to !== current.from) void store.reorder(moveIndex(shownRef.current, current.from, to));
    };
    const cancel = (event: Event) => {
      // Escape puts the rows back; a running answer keeps going.
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
      }
      setDrag(null);
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", cancel, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", cancel, true);
    };
  }, [dragging, store]);

  const onPointerDown = (event: ReactPointerEvent, index: number, onGrip: boolean) => {
    if (event.button !== 0 || !canStartDrag(event.pointerType, onGrip)) return;
    if ((event.target as Element).closest("button, input")) return;
    const rows = Array.from(
      list.current?.querySelectorAll<HTMLElement>(":scope > .nz-session") ?? [],
    );
    const boxes = rows.map((row) => row.getBoundingClientRect());
    setDrag({
      pointerId: event.pointerId,
      from: index,
      startY: event.clientY,
      startX: event.clientX,
      active: false,
      y: event.clientY,
      middles: boxes.map((box) => box.top + box.height / 2),
      heights: boxes.map((box) => box.height),
    });
  };

  const target = drag?.active ? dropIndex(drag.y, drag.middles, drag.from) : null;
  const offsetFor = (index: number): number => {
    if (!drag?.active || target === null) return 0;
    const height = drag.heights[drag.from] ?? 28;
    if (index === drag.from) return drag.y - drag.startY;
    if (drag.from < target && index > drag.from && index <= target) return -height;
    if (drag.from > target && index < drag.from && index >= target) return height;
    return 0;
  };

  return (
    <div className={`nz-sessions nz-sessions--${variant}`}>
      <div className="nz-sessions-new">
        {/* Text only with a literal "+" (spec 21.10); Dusk draws it as the purple button. */}
        <a
          href={`?`}
          className="nz-btn nz-btn--outline nz-btn--block nz-new-session"
          data-prefetch="false"
          onClick={(event) => {
            event.preventDefault();
            store.newSession();
          }}
        >
          + New session
        </a>
        {listError && (
          <p className="nz-inline-error nz-sessions-error" role="alert">
            <Icon name="alert" />
            <span>{listError}</span>
            <button
              type="button"
              className="nz-btn nz-btn--icon"
              aria-label="Dismiss"
              onClick={() => store.showListError(null)}
            >
              <Icon name="close" size={12} />
            </button>
          </p>
        )}
      </div>
      <div className="nz-sessions-list">
        {shown.length === 0 && shared.length === 0 ? (
          <p className="nz-sessions-empty">{AGENT_MESSAGES.noSessions}</p>
        ) : (
          <>
            <ul
              ref={list}
              className="nz-session-items"
              aria-label="Your sessions"
              data-dragging={drag?.active ? "true" : "false"}
            >
              {shown.map((session, index) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  index={index}
                  count={shown.length}
                  current={session.id === currentId}
                  runningHere={session.id === liveHere}
                  mine
                  dragging={Boolean(drag?.active) && offsetFor(index) !== 0}
                  offset={offsetFor(index)}
                  onPointerDown={onPointerDown}
                />
              ))}
            </ul>
            {shared.length > 0 && (
              <>
                <p className="nz-sessions-heading">Shared with the workspace</p>
                <ul className="nz-session-items" aria-label="Shared sessions">
                  {shared.map((session, index) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      index={index}
                      count={shared.length}
                      current={session.id === currentId}
                      runningHere={false}
                      mine={false}
                      dragging={false}
                      offset={0}
                      onPointerDown={() => {}}
                    />
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

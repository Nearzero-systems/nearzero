import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  clipQuote,
  fileSize,
  foldResult,
  questionFolds,
  shortReason,
} from "../../lib/agent/folding.ts";
import {
  copyTextOf,
  editVisible,
  elapsedLabel,
  isWorking,
  retryVisible,
  statusLabel,
  suggestionsVisible,
} from "../../lib/agent/turn-model.ts";
import type { PermissionCard, PersonMessage, StepPart, TurnModel } from "../../lib/agent/types.ts";
import { Icon, useAgent, useStore, workspacePath } from "./context.tsx";
import { FormSlot } from "./forms.tsx";
import { Markdown } from "./Markdown.tsx";
import { Expand, useHeightChange } from "./motion.tsx";

/**
 * The conversation (spec 19.4, 19.6): questions on the right, answers in Markdown with their
 * steps in line, the live status line, the turn footer with Copy, Retry and Edit, the permission
 * card, suggested follow-ups, "Ask Agent" on selected answer text, and following new text until
 * the person scrolls up.
 */

// ---- The person's message

function Attachments({ files }: { files: PersonMessage["files"] }) {
  if (files.length === 0) return null;
  return (
    <div className="nz-q-files">
      {files.map((file) =>
        file.kind === "image" && file.url ? (
          <a
            key={file.id}
            href={file.url}
            target="_blank"
            rel="noopener noreferrer"
            className="nz-q-thumb"
            title={file.name}
          >
            <img src={file.url} alt={file.name} loading="lazy" />
          </a>
        ) : (
          <a
            key={file.id}
            href={file.url || undefined}
            className="nz-file-chip"
            download={file.name}
            title={file.notice ?? file.name}
          >
            <Icon name="docs" />
            <span className="nz-file-name">{file.name}</span>
            <span className="nz-file-size">{fileSize(file.sizeBytes)}</span>
          </a>
        ),
      )}
    </div>
  );
}

function Question({ message }: { message: PersonMessage }) {
  const long = questionFolds(message.text);
  const [open, setOpen] = useState(false);
  const [bubble, change] = useHeightChange<HTMLDivElement>();
  return (
    <div className="nz-question">
      <div className="nz-bubble" ref={bubble}>
        {message.quote && (
          <blockquote className="nz-q-quote">
            {message.quote.length > 280 ? `${message.quote.slice(0, 280)}…` : message.quote}
          </blockquote>
        )}
        <Attachments files={message.files} />
        {message.text &&
          (long ? (
            <button
              type="button"
              className="nz-q-fold"
              aria-expanded={open}
              onClick={() => change(() => setOpen((value) => !value))}
            >
              <span className="nz-q-text" data-open={open ? "true" : "false"}>
                {message.text}
              </span>
              <span className="nz-q-more">{open ? "Show less" : "Show more"}</span>
            </button>
          ) : (
            <p className="nz-q-text">{message.text}</p>
          ))}
      </div>
    </div>
  );
}

// ---- Steps

const STEP_ICON = {
  running: null,
  succeeded: "check",
  failed: "close",
  stopped: "stop",
  needs_permission: "lock",
} as const;

const CHIP: Partial<Record<StepPart["state"], string>> = {
  failed: "Failed",
  stopped: "Stopped",
  needs_permission: "Needs permission",
};

function StepIcon({ state }: { state: StepPart["state"] }) {
  if (state === "running")
    return <span className="nz-action-spinner" aria-label="Running" role="img" />;
  if (state === "stopped") {
    return (
      <svg viewBox="0 0 24 24" width={14} height={14} aria-label="Stopped" role="img">
        <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
      </svg>
    );
  }
  const name = STEP_ICON[state] ?? "check";
  return <Icon name={name as "check"} label={CHIP[state] ?? "Done"} size={14} />;
}

const StepRow = memo(function StepRow({ step }: { step: StepPart }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [box, change] = useHeightChange<HTMLDivElement>();
  const expandable = Boolean(step.reason || step.result);
  const result = step.result ? foldResult(step.result, full) : null;
  const reasonUnder = step.state === "failed" && !open ? shortReason(step.reason) : null;
  const chip = CHIP[step.state];
  const head = (
    <>
      <span className={`nz-action-icon nz-action-icon--${step.state}`}>
        <StepIcon state={step.state} />
      </span>
      <span className="nz-action-label">{step.label}</span>
      {step.target && <span className="nz-action-target">{step.target}</span>}
      {chip && <span className={`nz-action-chip nz-action-chip--${step.state}`}>{chip}</span>}
      {expandable && <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />}
    </>
  );
  return (
    <div className="nz-action" data-state={step.state} ref={box}>
      {expandable ? (
        <button
          type="button"
          className="nz-action-row"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {head}
        </button>
      ) : (
        <div className="nz-action-row">{head}</div>
      )}
      {reasonUnder && <p className="nz-action-reason">{reasonUnder}</p>}
      <Expand open={open}>
        <div className="nz-action-detail">
          {step.reason && <p className="nz-action-reason nz-action-reason--full">{step.reason}</p>}
          {result && (
            <>
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling box needs focus for keyboard scrolling. */}
              <pre className="nz-action-result" tabIndex={0}>
                {result.shown}
              </pre>
              {result.folded ? (
                <button
                  type="button"
                  className="nz-code-more"
                  onClick={() => change(() => setFull(true))}
                >
                  Show more ({result.hiddenLines} more {result.hiddenLines === 1 ? "line" : "lines"}
                  )
                </button>
              ) : full ? (
                <button
                  type="button"
                  className="nz-code-more"
                  onClick={() => change(() => setFull(false))}
                >
                  Show less
                </button>
              ) : null}
              {(result.capped || step.resultTruncated) && (
                <p className="nz-action-note">The result is cut at 6,000 characters.</p>
              )}
            </>
          )}
        </div>
      </Expand>
    </div>
  );
});

// ---- Live status and the Agent's mark

function AgentMark({ active }: { active: boolean }) {
  const [shown, setShown] = useState(active);
  const [folding, setFolding] = useState(false);
  useEffect(() => {
    if (active) {
      setShown(true);
      setFolding(false);
      return;
    }
    if (!shown) return;
    setFolding(true);
    const timer = window.setTimeout(() => setShown(false), 280);
    return () => window.clearTimeout(timer);
  }, [active, shown]);
  if (!shown) return null;
  return (
    <div className="nz-mark" data-folding={folding ? "true" : "false"} aria-hidden="true">
      <span className="nz-mark-inner">
        <Icon name="agent" size={18} />
      </span>
    </div>
  );
}

function StatusLine({ turn }: { turn: TurnModel }) {
  const renderedAt = useAgent((state) => state.renderedAt);
  const [now, setNow] = useState(renderedAt);
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const label = statusLabel(turn);
  if (!label) return null;
  const waiting = turn.status?.kind === "waiting";
  const elapsed = waiting ? null : elapsedLabel(turn.workingSince, now);
  return (
    <div className="nz-status" role="status" aria-live="polite">
      <span className="nz-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="nz-status-label">{label}</span>
      {elapsed && <span className="nz-status-time">{elapsed}</span>}
      {!waiting && turn.state === "working" && <span className="nz-status-esc">esc to stop</span>}
    </div>
  );
}

// ---- Permission card (spec 19.9)

function Permission({
  turn,
  card,
  mine,
}: {
  turn: TurnModel;
  card: PermissionCard;
  mine: boolean;
}) {
  const store = useStore();
  const workspace = useAgent((state) => state.workspace);
  const canAllowPolicies = useAgent((state) => state.home.can.allowPolicies);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const settings = workspacePath(
    workspace,
    card.settingsPath || "/dashboard/settings/agent-policies",
  );
  const message = card.message || `The Agent needs permission: "${card.policyLabel}".`;
  return (
    <section className="nz-permission" aria-label="Permission needed">
      <header className="nz-permission-head">
        <Icon name="lock" />
        <span>{message}</span>
      </header>
      {card.production ? (
        <p className="nz-chatform-text">
          Production changes are turned on in Agent policies, with a typed confirmation.
        </p>
      ) : !canAllowPolicies || !card.canAllow ? (
        <p className="nz-chatform-text">
          Owners and admins decide what the Agent may do. Ask one to allow it in Settings → Agent
          policies.
        </p>
      ) : null}
      {error && (
        <p className="nz-inline-error" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}
      <div className="nz-chatform-actions">
        {card.allowed ? (
          <span className="nz-chatform-done">
            <Icon name="check" />
            <span>Allowed</span>
          </span>
        ) : (
          card.canAllow &&
          canAllowPolicies &&
          mine &&
          !card.production && (
            <button
              type="button"
              className="nz-btn nz-btn--primary"
              disabled={busy || isWorking(turn)}
              onClick={async () => {
                setBusy(true);
                setError(null);
                const problem = await store.allow(turn.id, card.policy);
                setBusy(false);
                if (problem) setError(problem);
              }}
            >
              {busy ? "Allowing…" : "Allow and continue"}
            </button>
          )
        )}
        <a className="nz-btn nz-btn--ghost" href={settings}>
          Agent policies
        </a>
      </div>
    </section>
  );
}

// ---- One turn

interface TurnProps {
  turn: TurnModel;
  isLast: boolean;
  mine: boolean;
  authorName: string | null;
}

const Turn = memo(function Turn({ turn, isLast, mine, authorName }: TurnProps) {
  const store = useStore();
  const working = isWorking(turn) || !turn.accepted;
  const copy = copyTextOf(turn);
  const waitingFormId =
    turn.live && turn.state === "waiting"
      ? [...turn.parts].reverse().find((part) => part.kind === "form" && !part.answered)?.key
      : undefined;
  const showRetry = retryVisible(turn, isLast, mine);
  const showEdit = editVisible(turn, isLast, mine);
  return (
    <article className="nz-turn" data-live={working ? "true" : "false"} data-turn={turn.id}>
      <Question message={turn.message} />
      <div className="nz-answer">
        <AgentMark active={working} />
        {turn.parts.map((part) => {
          switch (part.kind) {
            case "text":
              return (
                <div key={part.key} className="nz-answer-text" data-answer-text>
                  <Markdown text={part.text} />
                </div>
              );
            case "step":
              return <StepRow key={part.key} step={part} />;
            case "form":
              return (
                <FormSlot
                  key={part.key}
                  turn={turn}
                  part={part}
                  active={mine && part.key === waitingFormId}
                  authorName={authorName}
                />
              );
            case "notice":
              return (
                <p key={part.key} className="nz-notice">
                  <Icon name="info" />
                  <span>{part.text}</span>
                </p>
              );
            case "error":
              return (
                <p key={part.key} className="nz-answer-error" role="alert">
                  <Icon name="alert" />
                  <span>{part.message}</span>
                </p>
              );
            default:
              return null;
          }
        })}
        {turn.sendError && (
          <p className="nz-answer-error" role="alert">
            <Icon name="alert" />
            <span>{turn.sendError}</span>
          </p>
        )}
        {turn.permissions.map((card) => (
          <Permission key={card.stepId || card.policy} turn={turn} card={card} mine={mine} />
        ))}
        {working && <StatusLine turn={turn} />}
        {!working && (turn.footer || copy || showRetry || showEdit) && (
          <footer className="nz-turn-foot">
            {turn.footer && <span className="nz-turn-footer">{turn.footer}</span>}
            <span className="nz-turn-actions">
              {copy && (
                <button type="button" className="nz-btn nz-btn--ghost" data-copy={copy}>
                  Copy
                </button>
              )}
              {showRetry && (
                <button
                  type="button"
                  className="nz-btn nz-btn--ghost"
                  onClick={() => void store.retry(turn)}
                >
                  Retry
                </button>
              )}
              {showEdit && (
                <button
                  type="button"
                  className="nz-btn nz-btn--ghost"
                  onClick={() => store.edit(turn)}
                >
                  Edit
                </button>
              )}
            </span>
          </footer>
        )}
        {suggestionsVisible(turn, isLast) && mine && (
          <section className="nz-suggested" aria-label="Suggested">
            <span className="nz-suggested-label">Suggested</span>
            <div className="nz-suggested-list">
              {turn.suggestions.map((item) => (
                <button
                  key={item}
                  type="button"
                  className="nz-btn nz-btn--outline nz-suggestion"
                  onClick={() => void store.send(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </article>
  );
});

// ---- "Ask Agent" on a selection (spec 19.4)

function AskAboutSelection({ scroller }: { scroller: HTMLElement | null }) {
  const store = useStore();
  const [spot, setSpot] = useState<{ left: number; top: number; text: string } | null>(null);
  useEffect(() => {
    if (!scroller) return;
    const update = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setSpot(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const container =
        range.commonAncestorContainer instanceof Element
          ? range.commonAncestorContainer
          : range.commonAncestorContainer.parentElement;
      const answer = container?.closest(".nz-answer");
      const text = selection.toString().trim();
      if (!answer || !scroller.contains(answer) || text === "") {
        setSpot(null);
        return;
      }
      const box = range.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      setSpot({
        left: Math.min(Math.max(8, box.left + box.width / 2 - 44), width - 100),
        top: Math.min(box.bottom + 6, window.innerHeight - 40),
        text,
      });
    };
    const onScroll = () => setSpot(null);
    document.addEventListener("selectionchange", update);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      document.removeEventListener("selectionchange", update);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [scroller]);
  if (!spot) return null;
  return createPortal(
    <button
      type="button"
      className="nz-btn nz-btn--outline nz-ask-selection"
      style={{ left: spot.left, top: spot.top }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        store.setQuote(clipQuote(spot.text));
        window.getSelection()?.removeAllRanges();
        setSpot(null);
      }}
    >
      Ask Agent
    </button>,
    document.body,
  );
}

// ---- The conversation

export function Conversation() {
  const store = useStore();
  const turns = useAgent((state) => state.chat.turns);
  const session = useAgent((state) => state.chat.session);
  const more = useAgent((state) => state.chat.more);
  const loadingMore = useAgent((state) => state.chat.loadingMore);
  const follow = useAgent((state) => state.follow);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const mine = session ? session.mine : true;
  const authorName = session && !session.mine ? session.author.name : null;

  const toBottom = useCallback((smooth = false) => {
    const element = scrollerRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  useLayoutEffect(() => {
    if (following.current) toBottom();
  });

  // A new message or an opened session: follow again from the end.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `follow` is the signal to run again.
  useLayoutEffect(() => {
    following.current = true;
    store.setAway(false);
    toBottom();
  }, [follow, toBottom, store]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (following.current) toBottom();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [toBottom]);

  const onScroll = () => {
    const element = scrollerRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const atEnd = distance < 48;
    following.current = atEnd;
    store.setAway(!atEnd);
  };

  return (
    <>
      <div
        className="nz-chat-scroll"
        ref={(node) => {
          scrollerRef.current = node;
          setScroller(node);
        }}
        onScroll={onScroll}
      >
        <div className="nz-thread" ref={contentRef}>
          {more && (
            <div className="nz-thread-more">
              <button
                type="button"
                className="nz-btn nz-btn--ghost"
                disabled={loadingMore}
                onClick={() => void store.loadEarlier()}
              >
                {loadingMore ? "Loading…" : "Show earlier messages"}
              </button>
            </div>
          )}
          {session && !session.mine && (
            <p className="nz-inline-note nz-thread-note">
              {session.author.name} shared this session with the workspace. Only they can send
              messages in it.
            </p>
          )}
          {turns.map((turn, index) => (
            <Turn
              key={turn.id}
              turn={turn}
              isLast={index === turns.length - 1}
              mine={mine}
              authorName={authorName}
            />
          ))}
        </div>
      </div>
      <AskAboutSelection scroller={scroller} />
    </>
  );
}

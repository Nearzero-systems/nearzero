import { AGENT_MESSAGES } from "@nearzero/shared/browser";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { composerHeight, enterSends, sendState } from "../../lib/agent/composer-rules.ts";
import { fileSize } from "../../lib/agent/folding.ts";
import { isWorking } from "../../lib/agent/turn-model.ts";
import { Icon, useAgent, useStore } from "./context.tsx";
import { ResearchKeyFields } from "./forms.tsx";
import type { ComposerFile } from "./store.ts";

/**
 * The message box (spec 19.3, 21.10): it grows to about 8 lines; Enter sends on a computer and
 * Return adds a line on a phone (Ctrl/Cmd+Enter sends everywhere); files come from "+", a drop
 * or a paste and upload three at a time with progress; Deep research; one Send / Stop button.
 * On the empty home it sits under the greeting (the home puts the disclaimer under the
 * starters); in a conversation it docks at the bottom with the disclaimer under it.
 */

/**
 * The box moves between the home and the dock in one render; a box that had focus keeps it
 * after the move (and only then: leaving the page and coming back focuses nothing).
 */
let focusedAt = 0;

function FileChip({ file }: { file: ComposerFile }) {
  const store = useStore();
  const busy = file.state === "uploading" || file.state === "queued" || file.state === "preparing";
  const problem = file.error ?? file.notice;
  return (
    <div
      className="nz-attach-chip"
      data-state={file.state}
      title={problem ?? `${file.name} · ${fileSize(file.sizeBytes)}`}
    >
      {file.preview ? (
        <img className="nz-attach-thumb" src={file.preview} alt="" />
      ) : (
        <Icon name={file.state === "failed" ? "alert" : "docs"} size={14} />
      )}
      <span className="nz-file-name">{file.name}</span>
      <span className="nz-file-size">
        {file.state === "uploading"
          ? `${Math.round(file.progress * 100)}%`
          : file.state === "queued" || file.state === "preparing"
            ? "Waiting…"
            : fileSize(file.sizeBytes)}
      </span>
      {problem && (
        <span className={file.error ? "nz-attach-error" : "nz-attach-notice"}>
          <Icon name={file.error ? "alert" : "info"} size={12} label={problem} />
        </span>
      )}
      {busy ? (
        <button
          type="button"
          className="nz-btn nz-btn--icon nz-attach-x"
          aria-label={`Cancel the upload of ${file.name}`}
          title="Cancel upload"
          onClick={() =>
            file.state === "uploading" ? store.cancelUpload(file.key) : store.removeFile(file.key)
          }
        >
          <Icon name="close" size={12} />
        </button>
      ) : (
        <button
          type="button"
          className="nz-btn nz-btn--icon nz-attach-x"
          aria-label={`Remove ${file.name}`}
          title="Remove"
          onClick={() => store.removeFile(file.key)}
        >
          <Icon name="close" size={12} />
        </button>
      )}
      {file.state === "uploading" && (
        <span
          className="nz-attach-progress"
          style={{ width: `${Math.round(file.progress * 100)}%` }}
        />
      )}
    </div>
  );
}

export function Composer({ placement }: { placement: "home" | "dock" }) {
  const store = useStore();
  const composer = useAgent((state) => state.composer);
  const home = useAgent((state) => state.home);
  const lastTurn = useAgent((state) => state.chat.turns.at(-1) ?? null);
  const readOnly = useAgent((state) => state.chat.session !== null && !state.chat.session.mine);
  const away = useAgent((state) => state.away && state.chat.turns.length > 0);
  const box = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [phone, setPhone] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(pointer: coarse)");
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${composerHeight(element.scrollHeight, 24, 8)}px`;
  });

  useLayoutEffect(() => {
    const element = box.current;
    if (element && Date.now() - focusedAt < 500) {
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
    }
    focusedAt = 0;
    return () => {
      if (element !== null && document.activeElement === element) focusedAt = Date.now();
    };
  }, []);

  useEffect(() => {
    if (composer.focus === 0) return;
    const element = box.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, [composer.focus]);

  const working =
    lastTurn !== null &&
    (isWorking(lastTurn) || !lastTurn.accepted) &&
    lastTurn.state === "working";
  const uploading = composer.files.some(
    (file) => file.state === "uploading" || file.state === "queued" || file.state === "preparing",
  );
  const hasContent =
    composer.text.trim() !== "" || composer.files.some((file) => file.state !== "failed");
  const action = sendState({ hasContent, working, uploading, readOnly, disabled: false });
  const placeholder = composer.quote
    ? AGENT_MESSAGES.placeholderWithQuote
    : AGENT_MESSAGES.placeholder;

  const submit = () => {
    if (action === "stop") return;
    if (action === "off") return;
    void store.send();
  };

  return (
    <div className={placement === "home" ? "nz-dock nz-dock--home" : "nz-dock"}>
      {away && (
        <button
          type="button"
          className="nz-btn nz-btn--outline nz-jump"
          onClick={() => store.jumpToLatest()}
        >
          Jump to latest
        </button>
      )}
      {composer.researchCard && !home.research.keySaved && (
        <section className="nz-research-card" aria-label="Deep research key">
          <div className="nz-research-head">
            <Icon name="research" />
            <span>Deep research searches the web with your workspace's Firecrawl key.</span>
            <button
              type="button"
              className="nz-btn nz-btn--icon"
              aria-label="Close"
              onClick={() => store.closeResearchCard()}
            >
              <Icon name="close" />
            </button>
          </div>
          <ResearchKeyFields
            canSave={home.research.canAddKey}
            whoCanAdd={home.research.whoCanAdd}
            onSave={(key) => store.saveResearchKey(key)}
          />
        </section>
      )}
      <form
        className="nz-composer"
        data-composer
        data-dragging={dragging ? "true" : "false"}
        aria-label="Message the Agent"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onDragOver={(event) => {
          if (readOnly || !event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          setDragging(false);
          if (readOnly || event.dataTransfer.files.length === 0) return;
          event.preventDefault();
          store.addFiles(Array.from(event.dataTransfer.files));
        }}
      >
        {composer.quote && (
          <div className="nz-quote-chip">
            <Icon name="agent" size={12} />
            <span className="nz-quote-text">{composer.quote}</span>
            <button
              type="button"
              className="nz-btn nz-btn--icon"
              aria-label="Remove the quote"
              onClick={() => store.setQuote(null)}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        )}
        {composer.files.length > 0 && (
          <div className="nz-attach-list">
            {composer.files.map((file) => (
              <FileChip key={file.key} file={file} />
            ))}
          </div>
        )}
        <label htmlFor="nz-composer-input" className="nz-visually-hidden">
          Message
        </label>
        <textarea
          id="nz-composer-input"
          ref={box}
          name="message"
          rows={1}
          placeholder={
            readOnly ? "Only the person who started this session can send messages." : placeholder
          }
          disabled={readOnly}
          value={composer.text}
          maxLength={home.limits.messageChars || 20_000}
          data-composer-input
          onChange={(event) => store.setText(event.target.value)}
          onKeyDown={(event) => {
            if (enterSends(event.nativeEvent, phone)) {
              event.preventDefault();
              submit();
            }
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (files.length === 0) return;
            event.preventDefault();
            store.addFiles(files);
          }}
        />
        <div className="nz-composer-row">
          <button
            type="button"
            className="nz-btn nz-btn--icon nz-btn--outline"
            aria-label="Attach files"
            title="Attach files"
            disabled={readOnly}
            onClick={() => fileInput.current?.click()}
          >
            <Icon name="plus" />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              if (files.length > 0) store.addFiles(files);
            }}
          />
          <button
            type="button"
            className="nz-btn nz-btn--outline nz-toggle"
            aria-pressed={composer.deepResearch}
            disabled={readOnly}
            onClick={() => store.toggleResearch()}
          >
            <Icon name="domains" />
            Deep research
          </button>
          <span className="nz-composer-hint nz-small">
            {composer.queued ? "Sends when the uploads finish" : AGENT_MESSAGES.sendHint}
          </span>
          {action === "stop" ? (
            <button
              type="button"
              className="nz-btn nz-btn--primary nz-send"
              aria-label="Stop"
              title="Stop"
              data-stop
              onClick={() => store.stop()}
            >
              <svg viewBox="0 0 24 24" width={12} height={12} aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button
              type="submit"
              className="nz-btn nz-btn--primary nz-send"
              aria-label={action === "wait" ? "Send when the uploads finish" : "Send"}
              title={action === "wait" ? "Sends when the uploads finish" : "Send"}
              disabled={action === "off"}
              data-send
            >
              <Icon name="arrow-up" />
            </button>
          )}
        </div>
      </form>
      {composer.error && (
        <p className="nz-inline-error nz-composer-error" role="alert">
          <Icon name="alert" />
          <span>{composer.error}</span>
        </p>
      )}
      {!home.enabled && (
        <p className="nz-inline-note nz-composer-error">{AGENT_MESSAGES.disabled}</p>
      )}
      {placement === "dock" && (
        <p className="nz-disclaimer nz-small">{AGENT_MESSAGES.disclaimer}</p>
      )}
    </div>
  );
}

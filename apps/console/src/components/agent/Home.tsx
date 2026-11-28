import { AGENT_MESSAGES } from "@nearzero/shared/browser";
import { type ReactNode, useState } from "react";
import type { IconName } from "../../lib/icons.ts";
import { NAME_MAX_LENGTH } from "../../lib/names.ts";
import { Icon, useAgent, useStore } from "./context.tsx";

/**
 * The empty chat (spec 19.2, 21.10): one 760px column with the two-line greeting chosen for each
 * new chat (or the operator's fixed text), "What should I call you?" when the stored name looks
 * derived from the email, the message box right under the greeting, the four starters under the
 * box (three send at once, "Set up a server" only fills the box) and the disclaimer last.
 */

const STARTER_ICONS: IconName[] = ["git", "check", "alert", "server"];

function NamePrompt() {
  const store = useStore();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="nz-name-prompt"
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        const clean = name.trim();
        if (!clean) {
          setError("Enter your name.");
          return;
        }
        if (clean.length > NAME_MAX_LENGTH) {
          setError("Names can be up to 80 characters.");
          return;
        }
        setBusy(true);
        setError(null);
        const problem = await store.saveName(clean);
        setBusy(false);
        if (problem) setError(problem);
      }}
    >
      <label htmlFor="nz-first-name">What should I call you?</label>
      <input
        id="nz-first-name"
        name="firstName"
        className="nz-input"
        maxLength={NAME_MAX_LENGTH}
        autoComplete="given-name"
        placeholder="Your first name"
        value={name}
        aria-invalid={error ? "true" : undefined}
        aria-describedby="nz-first-name-error"
        onChange={(event) => setName(event.target.value)}
      />
      <button type="submit" className="nz-btn nz-btn--outline" disabled={busy}>
        Save
      </button>
      <p id="nz-first-name-error" className="nz-field-error" hidden={!error}>
        {error}
      </p>
    </form>
  );
}

export function Home({ composer }: { composer: ReactNode }) {
  const store = useStore();
  const greeting = useAgent((state) => state.greeting);
  const askName = useAgent((state) => state.home.greeting.askName);
  const starters = useAgent((state) => state.home.starters);
  const readOnly = useAgent((state) => state.chat.session !== null && !state.chat.session.mine);
  return (
    <div className="nz-home">
      <h1 className="nz-greeting">
        <span>{greeting[0]}</span>
        {greeting[1] && <span className="nz-greeting-second">{greeting[1]}</span>}
      </h1>
      {askName && <NamePrompt />}
      {composer}
      <div className="nz-starters">
        {starters.map((starter, index) => (
          <button
            key={starter.label}
            type="button"
            className="nz-starter"
            data-starter
            disabled={readOnly}
            onClick={() => {
              if (starter.send) void store.send(starter.text);
              else store.fill(starter.text);
            }}
          >
            <span className="nz-starter-icon">
              <Icon name={STARTER_ICONS[index] ?? "agent"} />
            </span>
            <span className="nz-starter-text">{starter.label}</span>
            <span className="nz-starter-number" aria-hidden="true">
              <span>{String(index + 1).padStart(2, "0")}</span>
              <span>→</span>
            </span>
          </button>
        ))}
      </div>
      <p className="nz-disclaimer nz-small">{AGENT_MESSAGES.disclaimer}</p>
    </div>
  );
}

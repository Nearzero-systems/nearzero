import type { FormRequest } from "@nearzero/shared/browser";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { agentApi, apiPath, failureWords } from "../../lib/agent/http.ts";
import {
  filterOptions,
  moveHighlight,
  optionHref,
  type PickerOption,
  pickerStyle,
  showsSearch,
} from "../../lib/agent/picker.ts";
import type { FormPart, TurnModel } from "../../lib/agent/types.ts";
import {
  counterText,
  initialRows,
  mergeBody,
  multiLineValue,
  namedCount,
  newRow,
  ONE_LINE_RULE,
  pasteEnv,
  rowProblems,
  rowsToSave,
  saveLabel,
  type VariableRow,
} from "../../lib/agent/variables-form.ts";
import { ApiError } from "../../lib/api-error.ts";
import { Icon, useAgent, useStore, workspacePath } from "./context.tsx";
import { usePresence } from "./motion.tsx";

/**
 * The secure forms and pickers inside the chat (spec 19.8). Values typed here go straight to
 * the normal API with the person's own session (variables, SSH keys, task scripts, keys); the
 * chat endpoint only learns the outcome and names. After saving, the form forgets the values.
 */

type Of<K extends FormRequest["kind"]> = Extract<FormRequest, { kind: K }>;

interface FormProps<K extends FormRequest["kind"]> {
  turn: TurnModel;
  part: FormPart;
  form: Of<K>;
}

function useAnswer(turn: TurnModel, part: FormPart) {
  const store = useStore();
  return (answer: Record<string, unknown>) => store.answerForm(turn.id, part.formId, answer);
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="nz-inline-error" role="alert">
      <Icon name="alert" />
      <span>{message}</span>
    </p>
  );
}

function errorWords(error: unknown, field?: string): string {
  if (error instanceof ApiError) {
    const first = field ? error.field(field) : undefined;
    return first ?? Object.values(error.fields)[0] ?? error.message;
  }
  return failureWords(error);
}

// ---- Variables

function VariablesForm({ turn, part, form }: FormProps<"variables">) {
  const answer = useAnswer(turn, part);
  const [rows, setRows] = useState<VariableRow[]>(() => initialRows(form.names));
  const [show, setShow] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "skip" | null>(null);
  const toSave = rowsToSave(rows);
  const reason = form.reason.includes("the Agent never sees them")
    ? form.reason
    : `${form.reason} Values go straight to Nearzero; the Agent never sees them.`;

  const update = (key: string, change: Partial<VariableRow>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));
    setRowErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const onPaste = (
    event: ClipboardEvent<HTMLInputElement>,
    key: string,
    field: "name" | "value",
  ) => {
    const text = event.clipboardData.getData("text");
    const outcome = pasteEnv(rows, text);
    if (outcome) {
      event.preventDefault();
      setRows(outcome.rows);
      setReport(outcome.report);
      setRowErrors({});
      return;
    }
    if (field === "value" && multiLineValue(text)) {
      event.preventDefault();
      setRowErrors((current) => ({ ...current, [key]: ONE_LINE_RULE }));
    }
  };

  const save = async () => {
    setError(null);
    const problems = rowProblems(rows);
    if (problems.length > 0) {
      setRowErrors(Object.fromEntries(problems.map((problem) => [problem.key, problem.message])));
      return;
    }
    if (toSave.length === 0) {
      setError(`Fill in at least one value, or choose "${form.skipLabel}".`);
      return;
    }
    setBusy("save");
    try {
      const path = apiPath(form.saveTo);
      const current = await agentApi<{
        own: { variables: { name: string }[]; version: number };
      }>("GET", path);
      await agentApi(
        "PUT",
        path,
        mergeBody(
          current.own.variables.map((variable) => variable.name),
          toSave,
          current.own.version,
        ),
      );
    } catch (failure) {
      setBusy(null);
      setError(errorWords(failure));
      return;
    }
    // Saved: the page forgets the values; the chat learns the names only.
    const names = toSave.map((row) => row.name);
    setRows((current) => current.map((row) => ({ ...row, value: "" })));
    const problem = await answer({ outcome: "saved", names });
    setBusy(null);
    if (problem) setError(problem);
  };

  const skip = async () => {
    setBusy("skip");
    const problem = await answer({ outcome: "skipped" });
    setBusy(null);
    if (problem) setError(problem);
  };

  return (
    <section className="nz-chatform-card" aria-label={`Variables for ${form.service.name}`}>
      <header className="nz-chatform-head">
        <Icon name="key" />
        <span className="nz-chatform-title">Variables for {form.service.name}</span>
      </header>
      <p className="nz-chatform-text">{reason}</p>
      <div className="nz-chatvar-rows">
        {rows.map((row) => (
          <div key={row.key} className="nz-chatvar-row">
            {row.fixed ? (
              <span className="nz-chatvar-name" title={row.name}>
                {row.name}
              </span>
            ) : (
              <input
                className="nz-input nz-chatvar-name-input"
                aria-label="Name"
                placeholder="NAME"
                value={row.name}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => update(row.key, { name: event.target.value })}
                onPaste={(event) => onPaste(event, row.key, "name")}
              />
            )}
            <input
              className="nz-input nz-chatvar-value"
              aria-label={`Value of ${row.name || "the new variable"}`}
              type={show ? "text" : "password"}
              placeholder="value"
              value={row.value}
              spellCheck={false}
              autoComplete="off"
              data-1p-ignore=""
              data-lpignore="true"
              onChange={(event) => update(row.key, { value: event.target.value })}
              onPaste={(event) => onPaste(event, row.key, "value")}
            />
            {row.fixed ? (
              <span className="nz-chatvar-spacer" aria-hidden="true" />
            ) : (
              <button
                type="button"
                className="nz-btn nz-btn--icon"
                aria-label="Remove this row"
                title="Remove this row"
                onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))}
              >
                <Icon name="close" />
              </button>
            )}
            {rowErrors[row.key] && (
              <p className="nz-field-error nz-chatvar-error">{rowErrors[row.key]}</p>
            )}
          </div>
        ))}
      </div>
      <div className="nz-chatvar-tools">
        <button
          type="button"
          className="nz-btn nz-btn--ghost"
          onClick={() => setRows((current) => [...current, newRow()])}
        >
          Add a variable
        </button>
        <button
          type="button"
          className="nz-btn nz-btn--ghost"
          onClick={() => setShow((value) => !value)}
          aria-pressed={show}
        >
          {show ? "Hide values" : "Show values"}
        </button>
        <span className="nz-chatvar-counter" aria-live="polite">
          {counterText(rows)}
        </span>
      </div>
      {report && (
        <p className="nz-inline-note" role="status">
          {report}
        </p>
      )}
      <FormError message={error} />
      <div className="nz-chatform-actions">
        <button
          type="button"
          className="nz-btn nz-btn--primary"
          disabled={busy !== null || toSave.length === 0}
          onClick={save}
        >
          {busy === "save"
            ? "Saving…"
            : saveLabel(form.deployLabel, toSave.length || namedCount(rows))}
        </button>
        <button
          type="button"
          className="nz-btn nz-btn--outline"
          disabled={busy !== null}
          onClick={skip}
        >
          {form.skipLabel}
        </button>
      </div>
      <p className="nz-chatform-hint">{form.hint}</p>
    </section>
  );
}

// ---- SSH key

function SshKeyForm({ turn, part, form }: FormProps<"ssh_key">) {
  const answer = useAnswer(turn, part);
  const [name, setName] = useState(form.suggestedName.slice(0, 100));
  const [tab, setTab] = useState<"generate" | "paste">("generate");
  const [generated, setGenerated] = useState<{ publicKey: string; privateKey: string } | null>(
    null,
  );
  const [privateKey, setPrivateKey] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"generate" | "save" | "cancel" | null>(null);
  const tabsId = useId();

  const generate = async () => {
    setError(null);
    setBusy("generate");
    try {
      const reply = await agentApi<{ publicKey: string; privateKey: string }>(
        "POST",
        "/ssh-keys/generate",
        {
          type: "ed25519",
          name: name.trim() || undefined,
        },
      );
      setGenerated({ publicKey: reply.publicKey, privateKey: reply.privateKey });
    } catch (failure) {
      setError(errorWords(failure));
    }
    setBusy(null);
  };

  const save = async () => {
    setError(null);
    const clean = name.trim();
    if (!clean) {
      setError("Give the key a name.");
      return;
    }
    const pair =
      tab === "generate"
        ? generated
        : { privateKey: privateKey.trim(), publicKey: publicKey.trim() };
    if (!pair?.privateKey) {
      setError(tab === "generate" ? "Generate the key first." : "Paste the private key.");
      return;
    }
    setBusy("save");
    let keyId: string;
    try {
      const reply = await agentApi<{ key: { id: string } }>("POST", "/ssh-keys", {
        name: clean,
        publicKey: pair.publicKey,
        privateKey: pair.privateKey,
      });
      keyId = reply.key.id;
    } catch (failure) {
      setBusy(null);
      setError(errorWords(failure));
      return;
    }
    // The private key leaves the page's memory once it is saved.
    setGenerated(null);
    setPrivateKey("");
    setPublicKey("");
    const problem = await answer({ outcome: "saved", keyId });
    setBusy(null);
    if (problem) setError(problem);
  };

  const cancel = async () => {
    setBusy("cancel");
    const problem = await answer({ outcome: "cancelled" });
    setBusy(null);
    if (problem) setError(problem);
  };

  return (
    <section className="nz-chatform-card" aria-label="SSH key">
      <header className="nz-chatform-head">
        <Icon name="key" />
        <span className="nz-chatform-title">SSH key</span>
      </header>
      {form.reason && <p className="nz-chatform-text">{form.reason}</p>}
      <label className="nz-chatform-field">
        <span className="nz-label">Name</span>
        <input
          className="nz-input"
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <div className="nz-tabs nz-tabs--lined" role="tablist" aria-label="How to add the key">
        {(["generate", "paste"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`${tabsId}-${value}`}
            aria-selected={tab === value}
            className="nz-tab"
            onClick={() => setTab(value)}
          >
            {value === "generate" ? "Generate" : "Paste"}
          </button>
        ))}
      </div>
      {tab === "generate" ? (
        <div role="tabpanel" aria-labelledby={`${tabsId}-generate`} className="nz-chatform-panel">
          {generated ? (
            <>
              <div className="nz-chatkey-box">
                <code>{generated.publicKey}</code>
                <button
                  type="button"
                  className="nz-btn nz-btn--outline"
                  data-copy={generated.publicKey}
                >
                  Copy
                </button>
              </div>
              <p className="nz-chatform-hint">
                Add this public key to ~/.ssh/authorized_keys on the server.
              </p>
            </>
          ) : (
            <button
              type="button"
              className="nz-btn nz-btn--outline"
              disabled={busy !== null}
              onClick={generate}
            >
              {busy === "generate" ? "Generating…" : "Generate an ED25519 key"}
            </button>
          )}
        </div>
      ) : (
        <div role="tabpanel" aria-labelledby={`${tabsId}-paste`} className="nz-chatform-panel">
          <label className="nz-chatform-field">
            <span className="nz-label">Private key</span>
            <textarea
              className="nz-textarea nz-mono"
              rows={4}
              spellCheck={false}
              autoComplete="off"
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              value={privateKey}
              onChange={(event) => setPrivateKey(event.target.value)}
            />
          </label>
          <label className="nz-chatform-field">
            <span className="nz-label">Public key</span>
            <textarea
              className="nz-textarea nz-mono"
              rows={2}
              spellCheck={false}
              autoComplete="off"
              placeholder="ssh-ed25519 AAAA…"
              value={publicKey}
              onChange={(event) => setPublicKey(event.target.value)}
            />
          </label>
        </div>
      )}
      <FormError message={error} />
      <div className="nz-chatform-actions">
        <button
          type="button"
          className="nz-btn nz-btn--primary"
          disabled={busy !== null}
          onClick={save}
        >
          {busy === "save" ? "Saving…" : "Save key"}
        </button>
        <button
          type="button"
          className="nz-btn nz-btn--outline"
          disabled={busy !== null}
          onClick={cancel}
        >
          Cancel
        </button>
      </div>
    </section>
  );
}

// ---- Task script

interface TaskNote {
  field: string;
  line: number | null;
  message: string;
}

function TaskScriptForm({ turn, part, form }: FormProps<"task_script">) {
  const answer = useAnswer(turn, part);
  const [script, setScript] = useState("");
  const [warnings, setWarnings] = useState<TaskNote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "cancel" | null>(null);
  const create = form.mode === "create";
  const label = warnings
    ? create
      ? "Schedule anyway"
      : "Save anyway"
    : create
      ? "Check and schedule"
      : "Check and save";

  const submit = async () => {
    setError(null);
    if (script.trim() === "") {
      setError("Paste the script first.");
      return;
    }
    setBusy("save");
    const force = warnings !== null;
    let taskId: string | null = null;
    try {
      const path = apiPath(form.saveTo);
      const draft = Object.fromEntries(
        Object.entries(form.draft ?? {}).filter(([, value]) => value !== null && value !== ""),
      );
      const reply = await agentApi<{
        saved: boolean;
        task?: { id: string };
        check?: { warnings: TaskNote[]; errors: TaskNote[] };
      }>(create ? "POST" : "PATCH", path, create ? { ...draft, script, force } : { script, force });
      if (reply.saved && reply.task) taskId = reply.task.id;
      else {
        setWarnings(reply.check?.warnings ?? []);
        if (reply.check?.errors?.length)
          setError(reply.check.errors.map((note) => note.message).join(" "));
      }
    } catch (failure) {
      setError(errorWords(failure, "script"));
    }
    if (!taskId) {
      setBusy(null);
      return;
    }
    setScript("");
    const problem = await answer({ outcome: "saved", taskId });
    setBusy(null);
    if (problem) setError(problem);
  };

  const cancel = async () => {
    setBusy("cancel");
    const problem = await answer({ outcome: "cancelled" });
    setBusy(null);
    if (problem) setError(problem);
  };

  const { summary } = form;
  return (
    <section className="nz-chatform-card" aria-label={`Task ${summary.task}`}>
      <header className="nz-chatform-head">
        <Icon name="tasks" />
        <span className="nz-chatform-title">{create ? "New task" : "Replace the script"}</span>
      </header>
      <dl className="nz-chattask-summary">
        <dt>Task</dt>
        <dd>{summary.task}</dd>
        <dt>Runs</dt>
        <dd>{summary.where}</dd>
        <dt>Schedule</dt>
        <dd>
          <code>{summary.schedule}</code> ({summary.timeZone || "UTC"})
        </dd>
        {summary.nextRun && (
          <>
            <dt>Next run</dt>
            <dd>{summary.nextRun}</dd>
          </>
        )}
        <dt>Shell</dt>
        <dd>{summary.shell}</dd>
      </dl>
      <label className="nz-chatform-field">
        <span className="nz-label">Script</span>
        <textarea
          className="nz-textarea nz-mono nz-chattask-script"
          rows={8}
          spellCheck={false}
          autoComplete="off"
          placeholder={form.placeholder}
          value={script}
          onChange={(event) => {
            setScript(event.target.value);
            setWarnings(null);
          }}
        />
      </label>
      {warnings && warnings.length > 0 && (
        <ul className="nz-chattask-warnings" aria-label="Warnings">
          {warnings.map((note) => (
            <li key={`${note.field}-${note.line}-${note.message}`}>{note.message}</li>
          ))}
        </ul>
      )}
      <FormError message={error} />
      <div className="nz-chatform-actions">
        <button
          type="button"
          className="nz-btn nz-btn--primary"
          disabled={busy !== null}
          onClick={submit}
        >
          {busy === "save" ? "Checking…" : label}
        </button>
        <button
          type="button"
          className="nz-btn nz-btn--outline"
          disabled={busy !== null}
          onClick={cancel}
        >
          Cancel
        </button>
      </div>
    </section>
  );
}

// ---- Model and research keys

function ModelKeyForm({ turn, part, form }: FormProps<"model_key">) {
  const answer = useAnswer(turn, part);
  const workspace = useAgent((state) => state.workspace);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!form.canSave) {
    return (
      <p className="nz-chatform-text">
        Add it in <a href={workspacePath(workspace, form.settingsPath)}>Settings → API keys</a>.
      </p>
    );
  }
  const save = async () => {
    setError(null);
    if (!key.trim()) {
      setError("Paste your organization's OpenRouter API key.");
      return;
    }
    setBusy(true);
    try {
      await agentApi("PUT", "/workspace/keys/model", { key: key.trim() });
    } catch (failure) {
      setBusy(false);
      setError(errorWords(failure, "key"));
      return;
    }
    setKey("");
    const problem = await answer({ outcome: "saved" });
    setBusy(false);
    if (problem) setError(problem);
  };
  return (
    <form
      className="nz-chatform-card nz-chatkey-form"
      aria-label="OpenRouter API key"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="nz-chatform-field">
        <span className="nz-label">OpenRouter API key</span>
        <input
          className="nz-input"
          type="password"
          autoComplete="off"
          placeholder={form.placeholder}
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
      </label>
      <FormError message={error} />
      <div className="nz-chatform-actions">
        <button type="submit" className="nz-btn nz-btn--primary" disabled={busy}>
          {busy ? "Saving…" : "Save key"}
        </button>
      </div>
    </form>
  );
}

export function ResearchKeyFields({
  canSave,
  whoCanAdd,
  onSave,
}: {
  canSave: boolean;
  whoCanAdd: string;
  onSave: (key: string) => Promise<string | null>;
}) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!canSave) return <p className="nz-chatform-text">{whoCanAdd}</p>;
  return (
    <form
      className="nz-research-fields"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!key.trim()) {
          setError("Paste your Firecrawl API key.");
          return;
        }
        setBusy(true);
        setError(null);
        const problem = await onSave(key.trim());
        setBusy(false);
        if (problem) setError(problem);
        else setKey("");
      }}
    >
      <input
        className="nz-input"
        type="password"
        autoComplete="off"
        aria-label="Firecrawl API key"
        placeholder="fc-…"
        value={key}
        onChange={(event) => setKey(event.target.value)}
      />
      <button type="submit" className="nz-btn nz-btn--primary" disabled={busy}>
        {busy ? "Checking…" : "Save and turn on"}
      </button>
      <FormError message={error} />
    </form>
  );
}

function ResearchKeyForm({ turn, part, form }: FormProps<"research_key">) {
  const answer = useAnswer(turn, part);
  const store = useStore();
  return (
    <section className="nz-chatform-card" aria-label="Research key">
      <p className="nz-chatform-text">Deep research needs your workspace's Firecrawl API key.</p>
      <ResearchKeyFields
        canSave={form.canSave}
        whoCanAdd={form.whoCanAdd}
        onSave={async (key) => (await store.saveResearchKey(key)) ?? answer({ outcome: "saved" })}
      />
    </section>
  );
}

// ---- Project name and delete

function ProjectNameForm({ turn, part, form }: FormProps<"project_name">) {
  const answer = useAnswer(turn, part);
  const [name, setName] = useState(form.suggestion ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="nz-chatform-card"
      aria-label="Project name"
      onSubmit={async (event) => {
        event.preventDefault();
        const clean = name.trim();
        if (!clean) {
          setError("Enter a name for the project.");
          return;
        }
        if (clean.length > 100) {
          setError("Project names can be up to 100 characters.");
          return;
        }
        setBusy(true);
        const problem = await answer({ outcome: "named", name: clean });
        setBusy(false);
        if (problem) setError(problem);
      }}
    >
      <label className="nz-chatform-field">
        <span className="nz-label">{form.label}</span>
        <input
          className="nz-input"
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <FormError message={error} />
      <div className="nz-chatform-actions">
        <button type="submit" className="nz-btn nz-btn--primary" disabled={busy}>
          Create project
        </button>
      </div>
    </form>
  );
}

function ProjectDeleteForm({ turn, part, form }: FormProps<"project_delete">) {
  const answer = useAnswer(turn, part);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"delete" | "keep" | null>(null);
  const choose = async (outcome: "delete" | "keep") => {
    setBusy(outcome);
    const problem = await answer({ outcome });
    setBusy(null);
    if (problem) setError(problem);
  };
  return (
    <section
      className="nz-chatform-card nz-chatform-card--danger"
      aria-label={`Delete ${form.project.name}`}
    >
      <p className="nz-chatform-text">{form.summary}</p>
      {form.services.length > 0 && (
        <ul className="nz-delete-lines">
          {form.services.map((service) => (
            <li key={service.line}>{service.line}</li>
          ))}
        </ul>
      )}
      <FormError message={error} />
      <div className="nz-chatform-actions">
        <button
          type="button"
          className="nz-btn nz-btn--danger nz-btn--stacked"
          disabled={busy !== null}
          onClick={() => choose("delete")}
        >
          <span>{form.confirmLabel}</span>
          <span className="nz-btn-sub">{form.confirmHint}</span>
        </button>
        <button
          type="button"
          className="nz-btn nz-btn--outline"
          disabled={busy !== null}
          onClick={() => choose("keep")}
        >
          {form.keepLabel}
        </button>
      </div>
    </section>
  );
}

// ---- Pickers

function PickerForm({ turn, part, form }: FormProps<"picker">) {
  const answer = useAnswer(turn, part);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const style = pickerStyle(form.purpose, form.options, form.searchable);
  const choose = async (option: PickerOption) => {
    const href = optionHref(option);
    if (href) {
      window.location.assign(href);
      return;
    }
    setBusy(true);
    setError(null);
    const problem = await answer({ outcome: "chosen", option: option.value, label: option.label });
    setBusy(false);
    if (problem) setError(problem);
  };
  return (
    <section className="nz-chatform-card nz-picker" aria-label={form.title}>
      <p className="nz-chatform-title">{form.title}</p>
      {style === "buttons" ? (
        <div className="nz-picker-buttons">
          {form.options.map((option) => {
            const href = optionHref(option);
            const inner = (
              <>
                {form.purpose === "provider" && <Icon name="git" />}
                <span className="nz-picker-label">{option.label}</span>
                {option.description && <span className="nz-picker-desc">{option.description}</span>}
              </>
            );
            // A Connect button goes to Git provider settings and comes back to this chat.
            return href ? (
              <a
                key={option.value}
                href={href}
                className="nz-btn nz-btn--outline nz-picker-option"
                data-prefetch="false"
              >
                {inner}
              </a>
            ) : (
              <button
                key={option.value}
                type="button"
                className="nz-btn nz-btn--outline nz-picker-option"
                disabled={busy}
                onClick={() => choose(option)}
              >
                {inner}
              </button>
            );
          })}
        </div>
      ) : (
        <Dropdown options={form.options} disabled={busy} onChoose={choose} />
      )}
      <FormError message={error} />
    </section>
  );
}

function Dropdown({
  options,
  disabled,
  onChoose,
}: {
  options: PickerOption[];
  disabled: boolean;
  onChoose: (option: PickerOption) => void;
}) {
  const [open, setOpen] = useState(false);
  // The list stays for its fade out (spec 21.7).
  const presence = usePresence<HTMLDivElement>(open);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const listId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const shown = useMemo(() => filterOptions(options, query), [options, query]);
  const search = showsSearch(options);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setHighlight(shown.length > 0 ? 0 : -1);
  }, [shown]);

  const onKey = (event: KeyboardEvent) => {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      setHighlight((current) => moveHighlight(current, shown.length, event.key));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = shown[highlight];
      if (option) {
        setOpen(false);
        onChoose(option);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    }
  };

  return (
    <div className="nz-dropdown">
      <button
        ref={buttonRef}
        type="button"
        className="nz-btn nz-btn--outline nz-dropdown-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>Choose… ({options.length})</span>
        <Icon name="chevron-down" />
      </button>
      {presence.mounted && (
        // biome-ignore lint/a11y/noStaticElementInteractions: keys from the search box bubble here.
        <div
          ref={presence.ref}
          className="nz-dropdown-panel"
          data-motion={presence.leaving ? "out" : undefined}
          inert={presence.leaving}
          onKeyDown={onKey}
        >
          {search && (
            <input
              ref={searchRef}
              className="nz-input"
              aria-label="Search"
              placeholder="Search…"
              value={query}
              aria-controls={listId}
              aria-activedescendant={highlight >= 0 ? `${listId}-${highlight}` : undefined}
              onChange={(event) => setQuery(event.target.value)}
            />
          )}
          <div
            id={listId}
            role="listbox"
            tabIndex={search ? -1 : 0}
            className="nz-dropdown-list"
            aria-activedescendant={highlight >= 0 ? `${listId}-${highlight}` : undefined}
            ref={(node) => {
              if (node && !search && open) node.focus();
            }}
          >
            {shown.length === 0 ? (
              <p className="nz-dropdown-empty">Nothing matches.</p>
            ) : (
              shown.map((option, index) => (
                <div
                  key={option.value}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === highlight}
                  tabIndex={-1}
                  className="nz-dropdown-option"
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => {
                    setOpen(false);
                    onChoose(option);
                  }}
                  onKeyDown={onKey}
                >
                  <span className="nz-picker-label">{option.label}</span>
                  {option.description && (
                    <span className="nz-picker-desc">{option.description}</span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- One form in a turn

export function FormSlot({
  turn,
  part,
  active,
  authorName,
}: {
  turn: TurnModel;
  part: FormPart;
  active: boolean;
  authorName: string | null;
}) {
  if (part.answered) {
    if (part.answered.asMessage) {
      return (
        <div className="nz-question nz-question--inline">
          <div className="nz-bubble">{part.answered.label}</div>
        </div>
      );
    }
    return (
      <p className="nz-chatform-done">
        <Icon name="check" />
        <span>{part.answered.label}</span>
      </p>
    );
  }
  if (!active) {
    const waitingHere = turn.live && turn.state === "waiting";
    return (
      <p className="nz-chatform-done nz-chatform-done--muted">
        <Icon name="info" />
        <span>
          {waitingHere
            ? `Waiting for ${authorName ?? "the person who started this session"}.`
            : "This form was left unanswered."}
        </span>
      </p>
    );
  }
  const form = part.form;
  switch (form.kind) {
    case "variables":
      return <VariablesForm turn={turn} part={part} form={form} />;
    case "ssh_key":
      return <SshKeyForm turn={turn} part={part} form={form} />;
    case "task_script":
      return <TaskScriptForm turn={turn} part={part} form={form} />;
    case "model_key":
      return <ModelKeyForm turn={turn} part={part} form={form} />;
    case "research_key":
      return <ResearchKeyForm turn={turn} part={part} form={form} />;
    case "project_name":
      return <ProjectNameForm turn={turn} part={part} form={form} />;
    case "project_delete":
      return <ProjectDeleteForm turn={turn} part={part} form={form} />;
    case "picker":
      return <PickerForm turn={turn} part={part} form={form} />;
    default:
      return null;
  }
}

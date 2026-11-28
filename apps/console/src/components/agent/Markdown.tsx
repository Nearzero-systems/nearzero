import { Fragment, memo, type ReactNode, useMemo, useState } from "react";
import { CODE_FOLD_LINES, foldCode, showMoreLabel } from "../../lib/agent/folding.ts";
import {
  decodeEntities,
  languageLabel,
  lexAnswer,
  safeHref,
  type Token,
} from "../../lib/agent/markdown.ts";
import { useHeightChange } from "./motion.tsx";

/**
 * An answer's Markdown (spec 19.4), drawn from tokens: headings, lists, quotes, inline code,
 * tables that scroll sideways, and code cards with their language, Copy and folding after 24
 * lines. Raw HTML stays text; links open in a new tab.
 */

// biome-ignore lint/suspicious/noExplicitAny: marked's generic tokens carry any field.
type Any = any;

function inline(tokens: Token[] | undefined, prefix: string): ReactNode[] {
  if (!tokens) return [];
  return tokens.map((token, index) => {
    const key = `${prefix}-${index}`;
    const item = token as Any;
    switch (token.type) {
      case "text":
        return item.tokens ? (
          <Fragment key={key}>{inline(item.tokens, key)}</Fragment>
        ) : (
          <Fragment key={key}>{decodeEntities(String(item.text ?? ""))}</Fragment>
        );
      case "escape":
        return <Fragment key={key}>{String(item.text ?? "")}</Fragment>;
      case "strong":
        return <strong key={key}>{inline(item.tokens, key)}</strong>;
      case "em":
        return <em key={key}>{inline(item.tokens, key)}</em>;
      case "del":
        return <del key={key}>{inline(item.tokens, key)}</del>;
      case "codespan":
        return <code key={key}>{decodeEntities(String(item.text ?? ""))}</code>;
      case "br":
        return <br key={key} />;
      case "link": {
        const href = safeHref(String(item.href ?? ""));
        if (!href) return <Fragment key={key}>{inline(item.tokens, key)}</Fragment>;
        return (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer" data-prefetch="false">
            {inline(item.tokens, key)}
          </a>
        );
      }
      case "image": {
        // Pictures from answers are not loaded; their address is a link instead.
        const href = safeHref(String(item.href ?? ""));
        const label = String(item.text || item.href || "image");
        return href ? (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer">
            {label}
          </a>
        ) : (
          <Fragment key={key}>{label}</Fragment>
        );
      }
      case "checkbox":
        return (
          <input
            key={key}
            type="checkbox"
            checked={Boolean(item.checked)}
            readOnly
            disabled
            aria-label={item.checked ? "Done" : "Not done"}
          />
        );
      case "html":
        return <Fragment key={key}>{String(item.text ?? item.raw ?? "")}</Fragment>;
      default:
        return <Fragment key={key}>{String(item.raw ?? "")}</Fragment>;
    }
  });
}

export function CodeCard({ lang, code }: { lang: string | undefined; code: string }) {
  const [open, setOpen] = useState(false);
  const [card, change] = useHeightChange<HTMLDivElement>();
  const folded = foldCode(code, open);
  const total = code.replace(/\n$/, "").split("\n").length;
  const label = languageLabel(lang);
  return (
    <div className="nz-code-card" ref={card}>
      <div className="nz-code-head">
        <span className="nz-code-lang">{label}</span>
        <button type="button" className="nz-btn nz-btn--ghost nz-code-copy" data-copy={code}>
          Copy
        </button>
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling box needs focus for keyboard scrolling. */}
      <pre className="nz-code-body" tabIndex={0}>
        <code>{folded.shown}</code>
      </pre>
      {folded.folded ? (
        <button type="button" className="nz-code-more" onClick={() => change(() => setOpen(true))}>
          {showMoreLabel(folded.hiddenLines)}
        </button>
      ) : open && total > CODE_FOLD_LINES ? (
        <button type="button" className="nz-code-more" onClick={() => change(() => setOpen(false))}>
          Show less
        </button>
      ) : null}
    </div>
  );
}

function blocks(tokens: Token[] | undefined, prefix: string): ReactNode[] {
  if (!tokens) return [];
  const out: ReactNode[] = [];
  tokens.forEach((token, index) => {
    const key = `${prefix}-${index}`;
    const item = token as Any;
    switch (token.type) {
      case "space":
      case "def":
        return;
      case "paragraph":
        out.push(<p key={key}>{inline(item.tokens, key)}</p>);
        return;
      case "text":
        out.push(
          <Fragment key={key}>
            {item.tokens ? inline(item.tokens, key) : decodeEntities(String(item.text ?? ""))}
          </Fragment>,
        );
        return;
      case "heading": {
        const depth = Math.min(Math.max(Number(item.depth) || 1, 1), 4);
        const Tag = (["h3", "h4", "h5", "h6"] as const)[depth - 1] ?? "h6";
        out.push(
          <Tag key={key} className={`nz-md-h${depth}`}>
            {inline(item.tokens, key)}
          </Tag>,
        );
        return;
      }
      case "blockquote":
        out.push(<blockquote key={key}>{blocks(item.tokens, key)}</blockquote>);
        return;
      case "code":
        out.push(<CodeCard key={key} lang={item.lang} code={String(item.text ?? "")} />);
        return;
      case "hr":
        out.push(<hr key={key} />);
        return;
      case "list": {
        const items = (item.items as Any[]).map((entry: Any, position: number) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Markdown tokens have no identity but their place.
          <li key={`${key}-${position}`} className={entry.task ? "nz-md-task" : undefined}>
            {blocks(entry.tokens, `${key}-${position}`)}
          </li>
        ));
        out.push(
          item.ordered ? (
            <ol
              key={key}
              start={typeof item.start === "number" && item.start !== 1 ? item.start : undefined}
            >
              {items}
            </ol>
          ) : (
            <ul key={key}>{items}</ul>
          ),
        );
        return;
      }
      case "table": {
        const align = (value: string | null) =>
          value ? { textAlign: value as "left" | "right" | "center" } : undefined;
        out.push(
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a wide table scrolls sideways by keyboard too.
          <section key={key} className="nz-md-table" tabIndex={0} aria-label="Table">
            <table>
              <thead>
                <tr>
                  {(item.header as Any[]).map((cell: Any, column: number) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: table cells are positional.
                    <th key={`${key}-h${column}`} style={align(cell.align)}>
                      {inline(cell.tokens, `${key}-h${column}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(item.rows as Any[][]).map((row, rowIndex) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: table rows are positional.
                  <tr key={`${key}-r${rowIndex}`}>
                    {row.map((cell: Any, column: number) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: table cells are positional.
                      <td key={`${key}-r${rowIndex}-${column}`} style={align(cell.align)}>
                        {inline(cell.tokens, `${key}-r${rowIndex}-${column}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>,
        );
        return;
      }
      case "html":
        out.push(<p key={key}>{String(item.text ?? item.raw ?? "")}</p>);
        return;
      default:
        if (item.raw) out.push(<p key={key}>{String(item.raw)}</p>);
    }
  });
  return out;
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const tokens = useMemo(() => lexAnswer(text), [text]);
  return <div className="nz-md">{blocks(tokens, "b")}</div>;
});

import { useMemo } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { redactInternalIds } from "./redactInternalIds";

/**
 * Compact prose for assistant bubbles — uses Nearzero theme tokens so dark mode works.
 */
const chatComponents: Components = {
	p: ({ children }) => (
		<p className="mt-3 text-[13px] font-sans leading-snug tracking-normal text-[var(--nz-text)] first:mt-0 sm:text-[13px]">
			{children}
		</p>
	),
	ul: ({ children }) => (
		<ul className="my-3 list-disc space-y-1.5 pl-5 font-sans text-[13px] leading-snug text-[var(--nz-text)] first:mt-0">
			{children}
		</ul>
	),
	ol: ({ children }) => (
		<ol className="my-3 list-decimal space-y-1.5 pl-5 font-sans text-[13px] leading-snug text-[var(--nz-text)] first:mt-0">
			{children}
		</ol>
	),
	li: ({ children }) => (
		<li className="leading-relaxed [&>ol]:mt-2 [&>p]:mt-2 [&>ul]:mt-2">
			{children}
		</li>
	),
	strong: ({ children }) => (
		<strong className="font-semibold text-[var(--nz-text)]">{children}</strong>
	),
	em: ({ children }) => (
		<em className="italic text-[var(--nz-text-muted)]">{children}</em>
	),
	h1: ({ children }) => (
		<h1 className="mt-5 scroll-m-20 border-b border-[var(--nz-border)] pb-1.5 font-sans text-sm font-semibold text-[var(--nz-text)] first:mt-0">
			{children}
		</h1>
	),
	h2: ({ children }) => (
		<h2 className="mt-5 scroll-m-20 border-b border-[var(--nz-border)] pb-1.5 font-sans text-sm font-semibold text-[var(--nz-text)] first:mt-0">
			{children}
		</h2>
	),
	h3: ({ children }) => (
		<h3 className="mt-4 scroll-m-20 pb-0.5 font-sans text-[13px] font-semibold text-[var(--nz-text)] first:mt-0">
			{children}
		</h3>
	),
	blockquote: ({ children }) => (
		<blockquote className="my-3 border-l-2 border-[var(--nz-border-strong)] pl-3 font-sans text-[13px] italic leading-snug text-[var(--nz-text-muted)]">
			{children}
		</blockquote>
	),
	hr: () => <hr className="my-4 border-[var(--nz-border)]" />,
	a: ({ href, children }) => (
		<a
			href={href}
			className="font-sans text-[13px] text-[var(--nz-text)] underline underline-offset-2 hover:text-[var(--nz-text-muted)]"
			target="_blank"
			rel="noreferrer noopener"
		>
			{children}
		</a>
	),
	code: ({ className, children, ...props }) => {
		const isBlock =
			typeof className === "string" && className.includes("language-");
		if (isBlock) {
			return (
				<code
					className={`${className ?? ""} font-mono text-[11px] text-[var(--nz-text)]`}
					{...props}
				>
					{children}
				</code>
			);
		}
		return (
			<code
				className="rounded bg-[var(--nz-agent-code-bg)] px-1 py-px font-mono text-[11px] text-[var(--nz-text)]"
				{...props}
			>
				{children}
			</code>
		);
	},
	pre: ({ children }) => (
		<pre className="my-3 max-w-full overflow-x-auto rounded-md bg-[var(--nz-agent-code-bg)] p-3 font-mono text-[11px] text-[var(--nz-text)] [&_code]:bg-transparent">
			{children}
		</pre>
	),
	table: ({ children }) => (
		<div className="my-3 max-w-full overflow-x-auto rounded-md border border-[var(--nz-border)]">
			<table className="w-full min-w-[max-content] border-collapse font-sans text-[12px] text-[var(--nz-text)]">
				{children}
			</table>
		</div>
	),
	thead: ({ children }) => (
		<thead className="bg-[var(--nz-bg-muted)]">{children}</thead>
	),
	th: ({ children }) => (
		<th className="border border-[var(--nz-border)] px-2.5 py-2 text-left text-[11px] font-semibold text-[var(--nz-text)]">
			{children}
		</th>
	),
	td: ({ children }) => (
		<td className="border border-[var(--nz-border)] px-2.5 py-2 align-top text-[12px] leading-snug text-[var(--nz-text-muted)]">
			{children}
		</td>
	),
	tr: ({ children }) => <tr>{children}</tr>,
	tbody: ({ children }) => <tbody>{children}</tbody>,
};

type Props = {
	markdown: string;
};

type ParsedSeparator = {
	start: number;
	end: number;
	columnCount: number;
	text: string;
};

export function normalizeInlineMarkdownTables(markdown: string) {
	return markdown
		.split("\n")
		.map((line) => {
			if (!line.includes("|")) return line;

			const separator = findInlineTableSeparator(line);
			if (!separator) return line;

			const { columnCount, start: separatorStart } = separator;
			if (columnCount < 2) return line;

			const beforeSeparator = line.slice(0, separatorStart);
			const pipePositions = Array.from(beforeSeparator.matchAll(/\|/g)).map(
				(match) => match.index ?? -1,
			);
			if (pipePositions.length < columnCount + 1) return line;

			const headerStart = pipePositions[pipePositions.length - columnCount - 1];
			if (headerStart === undefined || headerStart < 0) return line;

			const prefix = line.slice(0, headerStart).trimEnd();
			const header = line.slice(headerStart, separatorStart).trim();
			if (!header || countMarkdownTableCells(header) !== columnCount)
				return line;

			let rest = line.slice(separator.end);
			const rows = [header, separator.text];
			while (true) {
				const next = readPipeRow(rest, columnCount);
				if (!next) break;
				rows.push(next.row);
				rest = rest.slice(next.end);
			}

			if (rows.length <= 2) return line;

			const suffix = rest.trimStart();
			return [prefix, rows.join("\n"), suffix].filter(Boolean).join("\n\n");
		})
		.join("\n");
}

function findInlineTableSeparator(line: string): ParsedSeparator | null {
	for (
		let start = line.indexOf("|");
		start !== -1;
		start = line.indexOf("|", start + 1)
	) {
		const separator = parseTableSeparatorAt(line, start);
		if (separator && separator.columnCount >= 2) return separator;
	}
	return null;
}

function parseTableSeparatorAt(
	line: string,
	start: number,
): ParsedSeparator | null {
	if (line[start] !== "|") return null;

	let position = start + 1;
	let columnCount = 0;

	while (position < line.length) {
		position = skipHorizontalSpace(line, position);
		if (line[position] === ":") position++;

		const dashStart = position;
		while (line[position] === "-") position++;
		if (position - dashStart < 3) return null;

		if (line[position] === ":") position++;
		position = skipHorizontalSpace(line, position);
		if (line[position] !== "|") return null;

		position++;
		columnCount++;

		const nextCellStart = skipHorizontalSpace(line, position);
		const nextDashStart =
			line[nextCellStart] === ":" ? nextCellStart + 1 : nextCellStart;
		if (line[nextDashStart] !== "-") break;
	}

	if (columnCount < 2) return null;
	return {
		start,
		end: position,
		columnCount,
		text: line.slice(start, position).trim(),
	};
}

function skipHorizontalSpace(text: string, start: number) {
	let position = start;
	while (position < text.length && /[ \t]/.test(text[position] ?? "")) {
		position++;
	}
	return position;
}

function countMarkdownTableCells(row: string) {
	const trimmed = row.trim();
	if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return 0;
	return Math.max(trimmed.split("|").length - 2, 0);
}

function readPipeRow(text: string, columnCount: number) {
	let offset = 0;
	while (offset < text.length && /[ \t]/.test(text[offset] ?? "")) offset++;
	if (text[offset] !== "|") return null;

	let end = offset;
	for (let pipes = 0; pipes < columnCount + 1; pipes++) {
		end = text.indexOf("|", pipes === 0 ? offset : end + 1);
		if (end === -1) return null;
	}

	const rowEnd = end + 1;
	const row = text.slice(offset, rowEnd).trim();
	let nextEnd = rowEnd;
	while (nextEnd < text.length && /[ \t]/.test(text[nextEnd] ?? "")) nextEnd++;
	return { row, end: nextEnd };
}

export function AgentChatMarkdown({ markdown }: Props) {
	const text = normalizeInlineMarkdownTables(redactInternalIds(markdown ?? ""));
	const plugins = useMemo(() => [remarkGfm], []);
	const components = useMemo(() => chatComponents, []);

	if (text.length === 0) {
		return null;
	}

	return (
		<div className="min-w-0 max-w-full [&_a]:break-words [&_pre]:max-w-full">
			<ReactMarkdown remarkPlugins={plugins} components={components}>
				{text}
			</ReactMarkdown>
		</div>
	);
}

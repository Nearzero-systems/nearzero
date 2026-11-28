import type { GitProviderKind } from "@nearzero/shared";
import type { PublicGitHost } from "./public-repo.ts";

/**
 * Reading a message for the guided flows (spec 19.7), with no lookups: the clauses it is made
 * of, and which flow (if any) each clause asks for. Everything here is deliberately narrow: a
 * clause that isn't plainly one of these requests is left to the model.
 */

/** How to build, as a request may name it ("with nixpacks", "with its Dockerfile"). */
export type ImportBuilder =
  | "dockerfile"
  | "compose"
  | "static"
  | "automatic"
  | "railpack"
  | "nixpacks"
  | "heroku"
  | "paketo";

/**
 * What an import request says about the new service besides where it goes (31d G4-06, R4-01):
 * honoured by the guided import, never dropped.
 */
export interface ImportDetails {
  /** The service's name ("as api", "called api"). */
  name: string | null;
  builder: ImportBuilder | null;
  /** The app's folder inside the repository ("from the apps/api folder"); "" is the root. */
  folder: string | null;
}

export type Intent =
  | { flow: "create_project"; name: string | null }
  | { flow: "delete_project"; names: string[]; saidProject: boolean }
  | { flow: "deploy_name"; name: string }
  | ({
      flow: "git_link";
      link: RepositoryLink;
      project: string | null;
      server: string | null;
      deploy: boolean;
    } & ImportDetails)
  | ({
      flow: "git_import";
      repository: string | null;
      provider: GitProviderKind | null;
      project: string | null;
      server: string | null;
      branch: string | null;
      deploy: boolean;
    } & ImportDetails);

/** Longer messages, and messages with code, are conversations for the model. */
const LONGEST_GUIDED_MESSAGE = 400;

/** Words that can start a request; a connector splits a clause only when one follows it. */
const VERBS = new Set(
  `add ask attach backup build cancel change check clone configure connect copy create delete
  deploy describe destroy disable drop eliminate enable expose explain find fix follow generate get
  give how import install invite is are can could would will do does launch link list look make
  migrate monitor move open please point publish put read rebuild redeploy reload remove rename
  restart restore retry run schedule set setup share ship show spin start stop tell turn
  unlink update upgrade use watch what when where which who why wipe`.split(/\s+/),
);

/** Openers people put before a request: "please", "can you", "I'd like to"… */
const OPENERS =
  /^(?:(?:ok(?:ay)?|hey|hi|hello|so|now|also|and|then|alright|great|thanks|agent)[,!.]?\s+)*(?:(?:please|pls|kindly)\s+)?(?:(?:can|could|would|will)\s+(?:you|u)\s+(?:please\s+)?|i(?:'d|\s+would)\s+like\s+(?:you\s+)?to\s+|i\s+(?:want|need)\s+(?:you\s+)?to\s+|let'?s\s+|go\s+ahead\s+and\s+|help\s+me\s+(?:to\s+)?)?(?:please\s+)?/i;

/** Polite endings and closing punctuation. */
const CLOSERS =
  /(?:[\s,]+(?:please|pls|thanks|thank\s+you|for\s+me|now|right\s+now|asap|thx))*[\s.!?]*$/i;

export function cleanClause(text: string): string {
  return text.trim().replace(OPENERS, "").replace(CLOSERS, "").replace(/\s+/g, " ").trim();
}

function firstWord(text: string): string {
  return (cleanClause(text).split(" ")[0] ?? "").toLowerCase().replace(/[^a-z']/g, "");
}

function startsWithVerb(text: string): boolean {
  return VERBS.has(firstWord(text));
}

const CONNECTOR =
  /\s*(?:,\s*)?\b(?:and\s+then|and\s+after\s+that|and\s+afterwards|after\s+that|afterwards|then|and\s+also|and)\b\s+|\s*,\s+/gi;

/**
 * The clauses of a message, in order ("delete X and then create Y" → two). A connector splits
 * only when a request follows it, so "rock and roll" or "delete live and shop" stay whole. Null
 * when the message is long or holds code: that is the model's. A message with a repository link
 * keeps the link's own words together ("clone it and deploy this frontend", "it is a next.js
 * app"), and has no length limit when that leaves one request (31d R4-01).
 */
export function splitClauses(text: string): string[] | null {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.includes("```")) return null;
  const linked = repositoryLink(trimmed) !== null;
  if (trimmed.length > LONGEST_GUIDED_MESSAGE && !linked) return null;
  const sentences = trimmed
    .split(/\n+|;\s*|(?<=[.!?])\s+(?=\S)/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const clauses: string[] = [];
  for (const sentence of sentences) {
    let start = 0;
    for (const match of sentence.matchAll(CONNECTOR)) {
      const at = match.index ?? 0;
      const rest = sentence.slice(at + match[0].length);
      if (!startsWithVerb(rest)) continue;
      const piece = sentence.slice(start, at).trim();
      if (piece !== "") clauses.push(piece);
      start = at + match[0].length;
    }
    const last = sentence.slice(start).trim();
    if (last !== "") clauses.push(last);
  }
  const cleaned = clauses.map(cleanClause).filter((clause) => clause !== "");
  if (cleaned.length === 0) return null;
  if (!linked) return cleaned;
  const merged = mergeLinkClauses(cleaned);
  return trimmed.length > LONGEST_GUIDED_MESSAGE && merged.length !== 1 ? null : merged;
}

/** Words that ask for a repository to be deployed (0.1.79's list, 31d R4-01). */
const DEPLOY_WORD =
  /\b(?:deploy|redeploy|import|clone|run|launch|host|ship|publish|serve|start|set\s*up|spin\s+up|put\s+(?:it\s+)?online|go\s+live|bring\s+in|pull\s+in|add|create)\b/i;

/** "clone", "clone it": a request with nothing of its own, before the link it is about. */
function onlyDeployWords(clause: string): boolean {
  const parts = words(clause.toLowerCase().replace(/[^\w'\s-]/g, " "));
  return (
    parts.length > 0 &&
    DEPLOY_WORD.test(clause) &&
    parts.every((word) => LINK_WORDS.has(word) || PRONOUNS.has(word) || DEPLOY_WORD.test(word))
  );
}

const BACK_REFERENCE =
  /^(?:\S+\s+)?(?:it|this|that|them|these|(?:the|this|that|our|my)\s+(?:app|application|service|repo|repository|code|project|site|website|frontend|backend|front\s*end|back\s*end|api))\b/i;

/**
 * Clauses about the link before or after it join it: a bare "clone" before it, and after it a
 * description ("it is a next.js app") or a request about the same thing ("deploy this frontend",
 * "run it on prod-1"). Anything that asks for something else stays its own clause.
 */
function mergeLinkClauses(clauses: string[]): string[] {
  const at = clauses.findIndex((clause) => repositoryLink(clause) !== null);
  if (at < 0) return clauses;
  let first = at;
  while (first > 0 && onlyDeployWords(clauses[first - 1] as string)) first--;
  let last = at;
  while (last + 1 < clauses.length) {
    const next = clauses[last + 1] as string;
    if (repositoryLink(next) !== null) break;
    const describes = !startsWithVerb(next) && !QUESTION_START.test(next);
    const refersBack = DEPLOY_WORD.test(firstWord(next)) && BACK_REFERENCE.test(next);
    if (!describes && !refersBack) break;
    last++;
  }
  return [
    ...clauses.slice(0, first),
    clauses.slice(first, last + 1).join(", "),
    ...clauses.slice(last + 1),
  ];
}

// ---- Shared word lists

const PRONOUNS = new Set([
  "it",
  "this",
  "that",
  "them",
  "these",
  "those",
  "one",
  "something",
  "anything",
  "everything",
  "all",
  "stuff",
  "things",
  "me",
]);

const PREPOSITIONS = new Set([
  "about",
  "above",
  "across",
  "after",
  "against",
  "along",
  "and",
  "around",
  "as",
  "at",
  "because",
  "before",
  "behind",
  "below",
  "but",
  "by",
  "during",
  "for",
  "from",
  "if",
  "in",
  "inside",
  "into",
  "like",
  "near",
  "of",
  "off",
  "on",
  "onto",
  "or",
  "over",
  "per",
  "since",
  "so",
  "than",
  "that",
  "then",
  "through",
  "to",
  "toward",
  "towards",
  "under",
  "until",
  "up",
  "upon",
  "using",
  "via",
  "when",
  "where",
  "which",
  "while",
  "with",
  "within",
  "without",
]);

function unquote(value: string): string {
  return value
    .trim()
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
    .replace(/[\s.!?,;:]+$/g, "")
    .trim();
}

function words(value: string): string[] {
  return value.split(/\s+/).filter((word) => word !== "");
}

/** Names like "for my blog" or "it again" aren't names (spec 19.7). */
function nameProblem(name: string): "empty" | "pronoun" | "preposition" | "long" | null {
  const parts = words(name.toLowerCase());
  const first = (parts[0] ?? "").replace(/[^a-z']/g, "");
  if (parts.length === 0) return "empty";
  if (parts.length > 6) return "long";
  if (PRONOUNS.has(first)) return "pronoun";
  if (PREPOSITIONS.has(first)) return "preposition";
  return null;
}

/** Git URLs (and bare host/owner/repo) are the model's (spec 19.7). */
export function hasGitUrl(text: string): boolean {
  return (
    /:\/\/|\bgit@|\.git\b/i.test(text) ||
    /\b(?:github\.com|gitlab\.com|bitbucket\.org|gitea\.com)\b/i.test(text) ||
    /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/[\w.-]+\/[\w.-]+/i.test(text)
  );
}

// ---- A pasted repository link (30d R4-01)

export interface RepositoryLink {
  host: PublicGitHost;
  /** owner/name, without ".git". */
  fullName: string;
  /** The branch a /tree/<branch> link names (used only when the repository has it). */
  branch: string | null;
}

const LINK =
  /(?:^|[\s(<"'])(?:https?:\/\/)?(?:www\.)?(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:-\/)?(?:tree|src\/branch)\/([\w./-]+?))?\/?\.?(?=$|[\s,!?)>"'])/i;

/** The repository a link names, on one of the four public hosts; SSH links aren't read. */
export function repositoryLink(text: string): RepositoryLink | null {
  if (/\bgit@|ssh:\/\//i.test(text)) return null;
  const match = LINK.exec(text);
  if (!match) return null;
  const [, host = "", owner = "", name = "", branch] = match;
  if (name === "" || owner === "" || /^\.+$/.test(name)) return null;
  return {
    host: host.toLowerCase() as PublicGitHost,
    fullName: `${owner}/${name}`,
    branch: branch ? branch.replace(/\/+$/, "") : null,
  };
}

/** Words that may sit around a pasted link when the person wants it deployed. */
const LINK_WORDS = new Set(
  `deploy redeploy import run host launch ship add create setup set up spin bring in pull put
  please pls can could would will you u me i i'd like want need to this it that repo repository
  app application code project service from the my our a an of on onto for with and now just
  again here`.split(/\s+/),
);

const NO_DEPLOY_WORDS = new Set([
  "just",
  "only",
  "don't",
  "dont",
  "do",
  "not",
  "without",
  "deploying",
  "deployment",
  "no",
]);

const QUESTION_START =
  /^(?:what|whats|what's|how|why|which|who|where|when|is|are|does|do|did|can|could|should|would|explain|tell|describe|summarize|summarise|review|analy[sz]e|compare|check|look|read|show|list|find|is\s+it)\b/i;

/**
 * A pasted link to one of the four public hosts runs the checked import when it is alone or said
 * with a word that asks for it to be deployed (31d R4-01, 0.1.79's rule), with what the message
 * says honoured: project, server, branch, the service's name, the builder and the folder.
 * Questions, other requests ("fork", "star") and details the import can't honour ("with port
 * 8080", "build command …") are the model's, whose Git action checks the link the same way.
 */
function linkIntent(said: string): Intent | null {
  const found = repositoryLink(said);
  if (!found) return null;
  const clause = said.trim();
  // A question about a link is the model's ("what does github.com/acme/web do?").
  if (/\?\s*$/.test(clause) || QUESTION_START.test(clause)) return null;
  const withoutLink = clause.replace(LINK, " ");
  const project = notADetail(projectIn(withoutLink));
  const server = notADetail(serverIn(withoutLink));
  const branch = found.branch ?? notADetail(branchIn(withoutLink));
  let rest = withoutLink;
  for (const value of [project, server, branch]) {
    if (value) rest = rest.replace(new RegExp(`\\b${escapeRegExp(value)}\\b`, "i"), " ");
  }
  rest = rest
    .replace(/\b(?:nearzero\s+host|host|server|into|in|under|branch|project)\b/gi, " ")
    .replace(/\bon\s+(?=$|[\s,.!?])/gi, " ");
  const leftover = words(rest.toLowerCase().replace(/[^\w'\s-]/g, " ")).filter(
    (word) => !LINK_WORDS.has(word) && !NO_DEPLOY_WORDS.has(word),
  );
  // Other words need a deploy word with them; without one ("fork", "star") it's the model's.
  if (leftover.length > 0 && !DEPLOY_WORD.test(withoutLink)) return null;
  const details = importDetails(rest, { namedMeansService: true });
  if (details === "model") return null;
  return {
    flow: "git_link",
    link: { ...found, branch },
    project,
    server,
    deploy: !saysNoDeploy(clause),
    ...details,
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// ---- What an import request says about the new service (31d G4-06, R4-01)

const BUILDERS_SAID: [ImportBuilder, RegExp][] = [
  ["dockerfile", /\b(?:(?:its|the|a|our|my)\s+)?(?:docker\s*file|containerfile)s?\b/gi],
  [
    "compose",
    /\b(?:(?:its|the|a|our|my)\s+)?(?:docker[\s-]?compose|compose)(?:\s+files?)?(?:\.ya?ml)?\b/gi,
  ],
  ["nixpacks", /\bnix\s*packs?\b/gi],
  ["railpack", /\brail\s*packs?\b/gi],
  ["heroku", /\bheroku(?:\s+buildpacks?)?\b/gi],
  ["paketo", /\bpaketo(?:\s+buildpacks?)?\b/gi],
  [
    "static",
    /\b(?:(?:a|the)\s+)?static(?:\s+(?:site|files?|builder|build|server|html|website|web\s*site))?\b/gi,
  ],
  [
    "automatic",
    /\b(?:automatic(?:ally)?\s+(?:language\s+)?(?:detection|detect(?:ed)?|builder|build)|auto[\s-]?detect(?:ion|ed)?)\b/gi,
  ],
];

/** "with its Dockerfile", "using the static builder": the words around a builder's name. */
const BUILDER_GLUE =
  /\b(?:with|using|use|via|through|by|as|builder|build(?:s|ing)?|to\s+build)\b/gi;

const FOLDER_SAID = [
  /\b(?:from|in|inside|under|at|within)\s+(?:the\s+)?["'`]?(\.?\/?[\w.-]+(?:\/[\w.-]+)*)\/?["'`]?\s+(?:sub)?(?:folder|directory|dir)\b/i,
  /\b(?:(?:sub|root\s+|base\s+|app\s+)?(?:folder|directory|dir)|build\s+path|path)\s*[:=]?\s*["'`]?(\.?\/?[\w.-]+(?:\/[\w.-]+)*)\/?["'`]?/i,
  /\b(?:from|in|inside|under)\s+(?:the\s+)?["'`]?(\.\/[\w.-]+(?:\/[\w.-]+)*|[\w.-]+(?:\/[\w.-]+)+)\/?["'`]?(?=$|[\s,.!?])/i,
];

const NAME_SAID =
  /\b(?:as|called|named|name\s+it|name\s+the\s+(?:service|app))\s+(?:(?:a|an|the|my|our)\s+)?(?:(?:new\s+)?(?:service|app|application)\s+)?(?:(?:called|named)\s+)?["'`]?([a-z0-9][a-z0-9-]{0,62})["'`]?(?=$|[\s,.!?])/i;
const NAME_SAID_AS =
  /\b(?:as|name\s+it)\s+(?:(?:a|an|the|my|our)\s+)?(?:(?:new\s+)?(?:service|app|application)\s+)?(?:(?:called|named)\s+)?["'`]?([a-z0-9][a-z0-9-]{0,62})["'`]?(?=$|[\s,.!?])/i;
/** Words after "as" that aren't a name ("as well", "as soon as possible"). */
const NOT_A_SERVICE_NAME = new Set([
  ...PRONOUNS,
  "a",
  "an",
  "the",
  "is",
  "well",
  "soon",
  "usual",
  "before",
  "always",
  "needed",
  "required",
  "possible",
  "described",
  "mentioned",
  "follows",
  "public",
  "private",
  "app",
  "application",
  "service",
  "site",
  "website",
  "repo",
  "repository",
]);

/**
 * Details the guided import has no step for: the model handles them (its Git action is checked
 * like the import), so nothing a person asked for is dropped (31d G4-06).
 */
const UNHONOURED =
  /`|\.\.|\b(?:commands?|cmd|scripts?|ports?|variables?|vars|env\s+vars?|secrets?|domains?|subdomains?|hostnames?|volumes?|mounts?|replicas?|memory|cpus?|ram|health\s*checks?|webhooks?|buildpacks?|production|staging|environments?|stage|spa|publish\s+dir(?:ectory)?|postgres(?:ql)?|mysql|mariadb|mongo(?:db)?|redis|valkey|databases?|dbs?|tasks?|cron|backups?|image|tag)\b/i;

/** "on port 8080" names no server called "port": the word is a detail for the model instead. */
function notADetail(value: string | null): string | null {
  if (value === null) return null;
  const word = UNHONOURED.exec(value);
  return word && word[0].length === value.length ? null : value;
}

/**
 * The service details a clause names, or "model" when it names one the guided import can't honour
 * (31d G4-06): several builders, a path outside the repository, commands, ports, variables…
 * `namedMeansService`: "called api" names the service (a pasted link names the repository
 * itself); in the Git import "called api" may name the repository, so only "as api" counts.
 */
export function importDetails(
  text: string,
  options: { namedMeansService: boolean },
): ImportDetails | "model" {
  let rest = ` ${text} `;
  const builders = new Set<ImportBuilder>();
  for (const [builder, pattern] of BUILDERS_SAID) {
    if (pattern.test(rest)) {
      builders.add(builder);
      rest = rest.replace(pattern, " ");
    }
    pattern.lastIndex = 0;
  }
  if (builders.size > 1) return "model";
  let folder: string | null = null;
  for (const pattern of FOLDER_SAID) {
    const match = pattern.exec(rest);
    if (!match?.[1]) continue;
    const raw = match[1].replace(/^\.\//, "").replace(/\/+$/, "");
    if (raw.split("/").some((part) => part === "..")) return "model";
    folder = raw === "." || raw.toLowerCase() === "root" ? "" : raw;
    rest = rest.replace(match[0], " ");
    break;
  }
  let name: string | null = null;
  const named = (options.namedMeansService ? NAME_SAID : NAME_SAID_AS).exec(rest);
  if (named?.[1] && !NOT_A_SERVICE_NAME.has(named[1].toLowerCase())) {
    name = named[1].toLowerCase();
    rest = rest.replace(named[0], " ");
  }
  if (builders.size > 0) rest = rest.replace(BUILDER_GLUE, " ");
  if (UNHONOURED.test(rest)) return "model";
  return { name, builder: [...builders][0] ?? null, folder };
}

// ---- Create a project

const CREATE_PROJECT =
  /^(?:create|make|add|start|set\s*up|spin\s+up)\s+(?:(?:a|an|one|another|the|me\s+a|us\s+a)\s+)?(?:(?:new|fresh|empty|blank)\s+)?projects?\b\s*(.*)$/i;
const NAMED =
  /^(?:(?:that\s+is\s+|which\s+is\s+)?(?:called|named|titled)|with\s+(?:the\s+)?name)\b\s*[:=]?\s*(.*)$/i;

/** Names that say nothing; the person is asked for a real one (spec 19.7, 20.1). */
export function isGenericProjectName(name: string): boolean {
  const clean = name.trim().toLowerCase().replace(/\s+/g, " ");
  return (
    clean === "" ||
    /^\d+$/.test(clean) ||
    /^(new|my|a|the|test|our)?\s*project(\s*#?\d+)?$/.test(clean) ||
    /^untitled(\s+project)?(\s*\d+)?$/.test(clean) ||
    /^(new|my)$/.test(clean) ||
    /^project\s*(name)?$/.test(clean)
  );
}

function createProjectIntent(clause: string): Intent | null {
  const match = CREATE_PROJECT.exec(clause);
  if (!match) return null;
  let rest = (match[1] ?? "").trim();
  if (rest === "") return { flow: "create_project", name: null };
  const named = NAMED.exec(rest);
  if (named) rest = named[1] ?? "";
  else if (/^[:=-]\s*/.test(rest)) rest = rest.replace(/^[:=-]\s*/, "");
  const name = unquote(rest);
  if (name === "") return { flow: "create_project", name: null };
  const problem = nameProblem(name);
  if (problem === "empty") return { flow: "create_project", name: null };
  if (problem) return null;
  return { flow: "create_project", name: isGenericProjectName(name) ? null : name };
}

// ---- Delete a project

const DELETE = /^(?:delete|remove|drop|destroy|get\s+rid\s+of|eliminate)\s+(.+)$/i;
const NEGATION =
  /\b(?:don'?t|do\s+not|doesn'?t|never|not|no|cannot|can'?t|won'?t|shouldn'?t|mustn'?t|without)\b/i;
/** Other kinds of things: a delete of these is the model's unless "project" is said. */
const OTHER_KINDS =
  /\b(?:services?|apps?|applications?|databases?|dbs?|servers?|domains?|hostnames?|keys?|ssh|logs?|branch(?:es)?|deployments?|deploys?|environments?|envs?|volumes?|tasks?|containers?|images?|variables?|vars?|secrets?|sessions?|chats?|messages?|files?|certificates?|certs?|providers?|repos?|repositor(?:y|ies)|members?|users?|backups?|webhooks?|ports?|mounts?|records?|zones?|stacks?|compose|cron|jobs?|policies|policy|routes?)\b/i;
const DETERMINERS = /^(?:(?:the|my|our|this|that|a|an|entire|whole|all\s+of|both)\s+)+/i;
const TRAILING_DELETE_WORDS =
  /(?:\s+(?:too|as\s+well|completely|entirely|permanently|forever|for\s+good|everywhere))+$/i;

function deleteProjectIntent(clause: string): Intent | null {
  if (NEGATION.test(clause)) return null;
  const match = DELETE.exec(clause);
  if (!match) return null;
  const target = unquote((match[1] ?? "").replace(TRAILING_DELETE_WORDS, ""))
    .replace(DETERMINERS, "")
    .trim();
  if (target === "") return null;
  const saidProject = /\bprojects?\b/i.test(target);
  // "delete the database in project shop" is about a database, whatever else it says.
  if (OTHER_KINDS.test(words(target)[0] ?? "")) return null;
  if (!saidProject && OTHER_KINDS.test(target)) return null;
  const bare = target
    .replace(/\bprojects?\b/gi, " ")
    .replace(/\b(?:called|named)\b/gi, " ")
    .replace(DETERMINERS, "")
    .replace(/\s+/g, " ")
    .trim();
  if (bare === "") return null;
  const names = bare
    .split(/\s*(?:,|&|\band\b)\s*/i)
    .map((name) => unquote(name.replace(DETERMINERS, "")))
    .filter((name) => name !== "");
  if (names.length === 0) return null;
  for (const name of names) {
    const problem = nameProblem(name);
    if (problem) return null;
  }
  return { flow: "delete_project", names: [...new Set(names)], saidProject };
}

// ---- "deploy <name>"

const DEPLOY_NAME =
  /^(?:re-?deploy|deploy|ship|launch)\s+(?:(?:the|my|our)\s+)?(.+?)(?:\s+(?:app|application|service|repo|repository))?(?:\s+(?:please|again|now))*$/i;
const NAME_TOKEN = /^[a-z0-9][\w.@/-]*$/i;
/** Words that don't name one thing: these go to the model (spec 19.7). */
const GENERIC = new Set([
  ...PRONOUNS,
  "a",
  "an",
  "again",
  "app",
  "apps",
  "application",
  "applications",
  "bitbucket",
  "branch",
  "build",
  "changes",
  "code",
  "git",
  "gitea",
  "github",
  "gitlab",
  "latest",
  "main",
  "master",
  "new",
  "now",
  "please",
  "project",
  "projects",
  "repo",
  "repos",
  "repository",
  "service",
  "services",
  "server",
  "servers",
  "update",
  "updates",
  "version",
  "whole",
]);

function deployNameIntent(clause: string): Intent | null {
  if (hasGitUrl(clause)) return null;
  const match = DEPLOY_NAME.exec(clause);
  if (!match) return null;
  const name = unquote(match[1] ?? "");
  const parts = words(name);
  if (parts.length === 0 || parts.length > 2) return null;
  for (const part of parts) {
    if (!NAME_TOKEN.test(part) || GENERIC.has(part.toLowerCase())) return null;
  }
  return { flow: "deploy_name", name };
}

// ---- Import from Git

const IMPORT_VERB =
  /^(?:import|add|create|connect|set\s*up|run|deploy|launch|spin\s+up|host|bring\s+in|pull\s+in)\b/i;
const IMPORT_NOUN = /\b(?:services?|apps?|applications?|repos?|repositor(?:y|ies))\b/i;
const CONNECT_ACCOUNT = /^connect\s+(?:my|our|a|the)?\s*(github|gitlab|bitbucket|gitea)\b/i;
const GIT_WORDS = /\b(?:git|github|gitlab|bitbucket|gitea|repos?|repositor(?:y|ies))\b/i;
/** Talk of these without Git words is not an import (spec 19.7). */
const NOT_GIT =
  /\b(?:images?|docker\s+hub|databases?|dbs?|postgres(?:ql)?|mysql|mariadb|mongo(?:db)?|redis|libsql|sqlite|compose|docker-compose|templates?|stacks?)\b/i;
/** Requests about something else that merely mention an app. */
const OTHER_TOPICS =
  /\b(?:logs?|tasks?|cron|backups?|domains?|hostnames?|ports?|mounts?|volumes?|firewall|terminal|restart|rollback|variables?|env\s+vars?|metrics|status)\b/i;
const NOT_A_REPO = new Set([
  ...GENERIC,
  "and",
  "for",
  "from",
  "in",
  "into",
  "my",
  "of",
  "on",
  "our",
  "private",
  "public",
  "some",
  "the",
  "to",
  "your",
  "api",
  "web",
  "site",
  "website",
  "frontend",
  "backend",
  "front",
  "back",
  "end",
  "called",
  "named",
]);

const COMMON_NAMES = new Set([
  "api",
  "app",
  "web",
  "site",
  "website",
  "frontend",
  "backend",
  "server",
  "service",
]);

function repositoryIn(clause: string): string | null {
  const owner = /(?:^|\s)([a-z0-9][\w.-]*\/[\w.-]+(?:\/[\w.-]+)*)(?=$|[\s,.!?])/i.exec(clause);
  if (owner) return (owner[1] ?? "").replace(/\.$/, "");
  // Common words (app, api, web…) name a repository only as owner/name or right before "repo".
  const before = /(?:^|\s)([\w.-]+)\s+(?:repo|repository)\b/i.exec(clause);
  const word = before?.[1]?.toLowerCase();
  if (before?.[1] && word && (COMMON_NAMES.has(word) || !NOT_A_REPO.has(word))) return before[1];
  const after = /\b(?:repo|repository)\s+(?:called\s+|named\s+)?["']?([\w.-]+)/i.exec(clause);
  if (after?.[1] && !NOT_A_REPO.has(after[1].toLowerCase())) return after[1];
  const named = /\b(?:called|named)\s+["']?([\w.-]+)/i.exec(clause);
  if (named?.[1] && !NOT_A_REPO.has(named[1].toLowerCase())) return named[1];
  const object =
    /^(?:import|deploy|launch|run|add|connect|set\s*up|spin\s+up|host)\s+(?:(?:my|the|our)\s+)?([\w.-]+)/i.exec(
      clause,
    );
  if (object?.[1] && !NOT_A_REPO.has(object[1].toLowerCase()) && !IMPORT_NOUN.test(object[1])) {
    return object[1];
  }
  return null;
}

function projectIn(clause: string): string | null {
  const patterns = [
    /\binto\s+(?:the\s+)?(?:project\s+)?["']?([\w.-]+)["']?(?:\s+project)?/i,
    /\b(?:in|to|under)\s+(?:the\s+)?project\s+["']?([\w.-]+)/i,
    /\b(?:in|to|under)\s+(?:the\s+)?["']?([\w.-]+)["']?\s+project\b/i,
  ];
  for (const pattern of patterns) {
    const found = pattern.exec(clause)?.[1];
    if (found && !NOT_A_REPO.has(found.toLowerCase())) return found;
  }
  return null;
}

function serverIn(clause: string): string | null {
  const patterns = [
    /\bon\s+(?:the\s+)?server\s+["']?([\w.:-]+)/i,
    /\bto\s+(?:the\s+)?server\s+["']?([\w.:-]+)/i,
    /\bon\s+(?:the\s+)?["']?([\w.:-]+)["']?\s+server\b/i,
    /\bon\s+(?:the\s+)?(nearzero\s+host|host)\b/i,
    /\bon\s+["']?([\w.:-]+)["']?(?=$|[\s,.!?])/i,
  ];
  for (const pattern of patterns) {
    const found = pattern.exec(clause)?.[1];
    if (found && !NOT_A_REPO.has(found.toLowerCase()) && !PRONOUNS.has(found.toLowerCase())) {
      return /host$/i.test(found) ? "host" : found;
    }
  }
  return null;
}

function branchIn(clause: string): string | null {
  const after = /\bbranch\s+["']?([\w./-]+)/i.exec(clause)?.[1];
  if (after && !NOT_A_REPO.has(after.toLowerCase())) return after;
  const before = /(?:^|\s)([\w./-]+)\s+branch\b/i.exec(clause)?.[1];
  if (before && !["the", "a", "default", "my", "that", "this"].includes(before.toLowerCase())) {
    return before;
  }
  return null;
}

/** "just import" or "don't deploy": create without deploying (spec 19.7). */
export function saysNoDeploy(text: string): boolean {
  return /\bjust\s+import\b|\bimport\s+only\b|\bonly\s+import\b|\bdon'?t\s+deploy\b|\bdo\s+not\s+deploy\b|\bwithout\s+deploying\b|\bno\s+deploy(?:ment)?\b|\bnot\s+deploy\b/i.test(
    text,
  );
}

function gitImportIntent(said: string): Intent | null {
  if (hasGitUrl(said)) return null;
  const clause = said.replace(/^just\s+/i, "");
  const account = CONNECT_ACCOUNT.exec(clause);
  const verb = IMPORT_VERB.test(clause);
  const ownerName = /(?:^|\s)[a-z0-9][\w.-]*\/[\w.-]+(?=$|[\s,.!?])/i.test(clause);
  if (!account && !(verb && (IMPORT_NOUN.test(clause) || ownerName))) return null;
  if (!account && NOT_GIT.test(clause) && !GIT_WORDS.test(clause)) return null;
  if (!account && OTHER_TOPICS.test(clause)) return null;
  const provider = /\b(github|gitlab|bitbucket|gitea)\b/i.exec(clause)?.[1]?.toLowerCase() as
    | GitProviderKind
    | undefined;
  const repository = account ? null : repositoryIn(clause);
  const project = notADetail(projectIn(clause));
  const server = notADetail(serverIn(clause));
  const branch = notADetail(branchIn(clause));
  // The builder, folder and name it says are honoured, or it's the model's (G4-06).
  let rest = clause;
  for (const value of [repository, project, server, branch]) {
    if (value) rest = rest.replace(new RegExp(`\\b${escapeRegExp(value)}\\b`, "i"), " ");
  }
  const details = importDetails(rest, { namedMeansService: false });
  if (details === "model") return null;
  return {
    flow: "git_import",
    repository,
    provider: provider ?? null,
    project,
    server,
    branch,
    deploy: !saysNoDeploy(said),
    ...details,
  };
}

/**
 * The flow a clause asks for, or null for the model. Deletes come first (they never fall back
 * to anything else), then creating a project, "deploy <name>", then the Git import.
 */
export function intentOf(clause: string): Intent | null {
  const clean = cleanClause(clause);
  if (clean === "") return null;
  return (
    linkIntent(clean) ??
    deleteProjectIntent(clean) ??
    createProjectIntent(clean) ??
    deployNameIntent(clean) ??
    gitImportIntent(clean)
  );
}

/** Database words: "deploy postgres" is the model's, not a repository name (spec 19.7). */
export function isDatabaseWord(name: string): boolean {
  return /^(?:postgres(?:ql)?|pg|mysql|mariadb|maria|mongo(?:db)?|redis|valkey|libsql|sqlite|turso|database|db|cache|memcached?)$/i.test(
    name.trim(),
  );
}

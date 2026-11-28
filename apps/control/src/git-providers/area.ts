/**
 * What the Agent uses from Git providers (spec 19.7 steps 1–3 and 6), with the asking person's
 * actor so the same access rules apply (spec 01 principle 1): the providers they may use, a
 * provider's repositories (searchable, at most 200), a repository's branches (default first, at
 * most 200), a branch's file list and small text files read through the API without cloning, and
 * the inspection bundle (the file list three folders deep, up to twelve manifest files, and the
 * runnable folders). Saving a provider source on a service is `saveProviderSource`. None of these
 * return a token or secret.
 */

export {
  getRepository,
  inspectRepository,
  listBranches,
  listFiles,
  listRepositories,
  readFile,
  usableProviders,
} from "./reads.ts";
export { providerCloneAccess, saveProviderSource } from "./sources.ts";

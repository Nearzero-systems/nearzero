import {
	gitProviderUiOptions,
	type GitProviderUiOption,
} from "@/lib/git-provider-ui";

export type ProviderOption = GitProviderUiOption;

export type ImportableRepo = {
  key: string;
  name: string;
  repo: string;
  branch: string;
  type: string;
  note: string;
  /** GitHub topics → framework name, else primary language; empty if unknown. */
  stackLabel: string;
  preset: string;
  rootDirectory: string;
  buildCommand: string;
  outputDirectory: string;
  envKey: string;
  envValue: string;
  updatedLabel: string;
  visibility: "private" | "public";
};

export type ProviderAccount = {
  key: string;
  label: string;
  repos: ImportableRepo[];
};

export const providerOptions: ProviderOption[] = gitProviderUiOptions;

/** Populated client-side for GitHub (API); other providers when linked. */
export const providerAccounts: Record<ProviderOption["key"], ProviderAccount[]> = {
  github: [],
  gitlab: [],
  bitbucket: [],
  gitea: [],
};

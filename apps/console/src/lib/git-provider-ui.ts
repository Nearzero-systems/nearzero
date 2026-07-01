export type GitProviderKind = "github" | "gitlab" | "bitbucket" | "gitea";

export type GitProviderUiOption = {
	key: GitProviderKind;
	label: string;
	buttonLabel: string;
	accent: string;
	iconPath: string;
	settingsHref: string;
};

export const gitProviderUiOptions: GitProviderUiOption[] = [
	{
		key: "github",
		label: "GitHub",
		buttonLabel: "Connect GitHub",
		accent: "#24292f",
		settingsHref: "/dashboard/settings/git-providers?connect=github",
		iconPath:
			"M12 2C6.48 2 2 6.58 2 12.23c0 4.52 2.87 8.35 6.84 9.7.5.1.68-.22.68-.5 0-.24-.01-1.05-.01-1.9-2.78.62-3.37-1.2-3.37-1.2-.46-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.35 1.12 2.92.85.09-.67.35-1.12.63-1.38-2.22-.26-4.55-1.14-4.55-5.08 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.31.1-2.72 0 0 .84-.28 2.75 1.05A9.3 9.3 0 0 1 12 6.84c.85 0 1.7.12 2.5.35 1.9-1.33 2.74-1.05 2.74-1.05.56 1.41.21 2.46.1 2.72.64.72 1.03 1.63 1.03 2.75 0 3.95-2.34 4.82-4.57 5.07.36.32.67.95.67 1.91 0 1.38-.01 2.49-.01 2.83 0 .28.18.6.69.5A10.23 10.23 0 0 0 22 12.23C22 6.58 17.52 2 12 2Z",
	},
	{
		key: "gitlab",
		label: "GitLab",
		buttonLabel: "Connect GitLab",
		accent: "#FC6D26",
		settingsHref: "/dashboard/settings/git-providers?connect=gitlab",
		iconPath:
			"m12 22.12 4.42-13.61H7.58L12 22.12Zm0-18.26L9.27 12.2h5.46L12 3.86Zm-7.41 8.35 2.01-6.18a.73.73 0 0 1 .69-.5h3.46L4.59 12.21Zm14.82 0-6.16-6.68h3.46c.32 0 .6.2.69.5l2.01 6.18Z",
	},
	{
		key: "bitbucket",
		label: "Bitbucket",
		buttonLabel: "Connect Bitbucket",
		accent: "#0052CC",
		settingsHref: "/dashboard/settings/git-providers?connect=bitbucket",
		iconPath:
			"M5.2 4.5h13.6c.36 0 .66.3.66.66v13.68a.66.66 0 0 1-.66.66H5.2a.66.66 0 0 1-.66-.66V5.16c0-.36.3-.66.66-.66Zm6.8 2.84c-1.96 0-3.57 1.59-3.57 3.55 0 1.09.51 2.07 1.31 2.73l-.53 2.04 2.79-1.5 2.79 1.5-.53-2.04a3.54 3.54 0 0 0 1.31-2.73A3.56 3.56 0 0 0 12 7.34Zm0 1.63c1.06 0 1.92.86 1.92 1.92A1.92 1.92 0 0 1 12 12.81a1.92 1.92 0 0 1-1.92-1.92c0-1.06.86-1.92 1.92-1.92Z",
	},
	{
		key: "gitea",
		label: "Gitea",
		buttonLabel: "Connect Gitea",
		accent: "#609926",
		settingsHref: "/dashboard/settings/git-providers?connect=gitea",
		iconPath:
			"M5.1 4.5c2.9 0 4.38 1.76 4.95 3.55h3.9c.57-1.79 2.05-3.55 4.95-3.55 1.61 0 2.7 1.09 2.7 2.6 0 2.23-1.86 4.17-4.98 4.58-.5 2.7-2.35 4.92-4.62 4.92s-4.12-2.22-4.62-4.92C4.26 11.27 2.4 9.33 2.4 7.1c0-1.51 1.09-2.6 2.7-2.6Zm.05 1.8c-.72 0-1.05.36-1.05.89 0 1.07 1.04 2.28 3.14 2.68-.02-.22-.04-.44-.04-.67 0-1.21-.56-2.9-2.05-2.9Zm13.7 0c-1.49 0-2.05 1.69-2.05 2.9 0 .23-.02.45-.04.67 2.1-.4 3.14-1.61 3.14-2.68 0-.53-.33-.89-1.05-.89ZM9.05 9.85c.18 2.58 1.45 4.95 2.95 4.95s2.77-2.37 2.95-4.95h-5.9Zm1.3 1.25h3.3v1.5h-3.3v-1.5Z",
	},
];

export function gitProviderUiOption(
	provider: string | undefined,
): GitProviderUiOption | undefined {
	return gitProviderUiOptions.find((option) => option.key === provider);
}

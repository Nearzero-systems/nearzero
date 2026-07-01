import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMessageInputPrompt } from "../src/components/dashboard/agent/AgentMessageInputPrompt";

describe("AgentMessageInputPrompt", () => {
	test("renders Git provider input requests as provider buttons", () => {
		const html = renderToStaticMarkup(
			<AgentMessageInputPrompt
				field="gitProviderId"
				options={[
					{
						label: "Connect GitHub",
						value: "connect:github",
						providerType: "github",
						description: "Connect GitHub",
					},
					{
						label: "Connect GitLab",
						value: "connect:gitlab",
						providerType: "gitlab",
						description: "Connect GitLab",
					},
					{
						label: "Connect Bitbucket",
						value: "connect:bitbucket",
						providerType: "bitbucket",
						description: "Connect Bitbucket",
					},
					{
						label: "Connect Gitea",
						value: "connect:gitea",
						providerType: "gitea",
						description: "Connect Gitea",
					},
				]}
				onSubmit={async () => {}}
			/>,
		);

		expect(html).toContain("GitHub");
		expect(html).toContain("GitLab");
		expect(html).toContain("Bitbucket");
		expect(html).toContain("Gitea");
		expect(html).toContain("grid-template-columns:repeat(4, minmax(0, 1fr))");
		expect(html).toContain("--nz-provider-accent");
	});
});

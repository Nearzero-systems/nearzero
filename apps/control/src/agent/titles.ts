import { cleanGeneratedTitle, filterSuggestions, stripInternalIds } from "@nearzero/shared";
import type { ControlServices } from "../services.ts";
import type { ModelProvider } from "./provider/provider.ts";
import { redactText } from "./redact.ts";
import { agentSettings } from "./settings.ts";
import "./tables.ts";

/**
 * The small model's two jobs (spec 19.4, 19.5): a 2 to 5 word session title within 6 seconds
 * that never replaces a name the person gave, and up to three follow-up requests written as the
 * person's own words.
 */

export async function generateTitle(
  services: ControlServices,
  provider: ModelProvider,
  key: string,
  sessionId: string,
  question: string,
): Promise<string | null> {
  const settings = agentSettings(services);
  const signal = AbortSignal.timeout(settings.titleTimeoutMs);
  let raw: string;
  try {
    raw = await provider.complete(
      key,
      {
        model: settings.smallModel,
        messages: [
          {
            role: "system",
            content:
              'Write a title for a chat that starts with the message below: 2 to 5 words, sentence case, no quotes, no final period. If the message is only a greeting or small talk, answer exactly "Greeting". Answer with the title only.',
          },
          { role: "user", content: redactText(question).slice(0, 2_000) },
        ],
        maxTokens: 24,
        temperature: 0.2,
      },
      { signal, silenceMs: settings.titleTimeoutMs },
    );
  } catch {
    return null;
  }
  const title = cleanGeneratedTitle(stripInternalIds(raw));
  if (!title) return null;
  const updated = await services.db
    .updateTable("agent_session")
    .set({ title, title_source: "generated", updated_at: new Date() })
    .where("id", "=", sessionId)
    .where((eb) => eb.or([eb("title_source", "=", "provisional"), eb("title_source", "is", null)]))
    .executeTakeFirst();
  return Number(updated.numUpdatedRows) > 0 ? title : null;
}

export async function suggestFollowUps(
  services: ControlServices,
  provider: ModelProvider,
  key: string,
  input: { question: string; answer: string; steps: string[] },
): Promise<string[]> {
  const settings = agentSettings(services);
  let raw: string;
  try {
    raw = await provider.complete(
      key,
      {
        model: settings.smallModel,
        messages: [
          {
            role: "system",
            content: [
              "Suggest up to 3 short next requests the person might send to Nearzero Agent after this exchange.",
              "Write each one as the person's own words, at most 9 words, naming a real project, service or server from the exchange where possible.",
              "Only suggest what the Agent can do: deploy, redeploy, start, stop, follow deployments, read logs, add domains, set variables through the form, add or set up servers, create projects, apps and databases, list and review tasks.",
              "Never suggest firewalls, logging in to a server, rebooting, editing authorized keys, billing, or anything outside Nearzero.",
              "Answer with one suggestion per line and nothing else. If nothing fits, answer with nothing.",
            ].join(" "),
          },
          {
            role: "user",
            content: redactText(
              `Question: ${input.question.slice(0, 1_500)}\n\nAnswer: ${input.answer.slice(0, 3_000)}\n\nActions: ${input.steps.join("; ").slice(0, 1_000)}`,
            ),
          },
        ],
        maxTokens: 120,
        temperature: 0.4,
      },
      { signal: AbortSignal.timeout(8_000), silenceMs: 8_000 },
    );
  } catch {
    return [];
  }
  return filterSuggestions(stripInternalIds(raw).split("\n"));
}

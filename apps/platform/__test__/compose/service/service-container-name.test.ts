import type { ComposeSpecification } from "@nearzero/server";
import { addSuffixToServiceNames, generateRandomHash } from "@nearzero/server";
import { expect, test } from "vitest";
import { parse } from "yaml";

const composeFile = `
version: "3.8"

services:
  web:
    image: nginx:latest
    container_name: web_container

  api:
    image: myapi:latest

networks:
  default:
    driver: bridge
`;

test("Generate random hash with 8 characters", () => {
	const hash = generateRandomHash();

	expect(hash).toBeDefined();
	expect(hash.length).toBe(8);
});

test("Add suffix to service names with container_name in compose file", () => {
	const composeData = parse(composeFile) as ComposeSpecification;

	const suffix = generateRandomHash();

	if (!composeData.services) {
		return;
	}
	const updatedComposeData = addSuffixToServiceNames(
		composeData.services,
		suffix,
	);
	const actualComposeData = { ...composeData, services: updatedComposeData };

	// Check that the container name changed correctly
	expect(actualComposeData.services?.[`web-${suffix}`]?.container_name).toBe(
		`web_container-${suffix}`,
	);
	// Check that the new service key has the prefix and the old key is gone
	expect(actualComposeData.services).toHaveProperty(`web-${suffix}`);
	expect(actualComposeData.services).not.toHaveProperty("web");

	// Check that the image configuration is unchanged
	expect(actualComposeData.services?.[`web-${suffix}`]?.image).toBe(
		"nginx:latest",
	);
	expect(actualComposeData.services?.[`api-${suffix}`]?.image).toBe(
		"myapi:latest",
	);
});

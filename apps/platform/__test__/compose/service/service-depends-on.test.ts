import type { ComposeSpecification } from "@nearzero/server";
import { addSuffixToServiceNames, generateRandomHash } from "@nearzero/server";
import { expect, test } from "vitest";
import { parse } from "yaml";

test("Generate random hash with 8 characters", () => {
	const hash = generateRandomHash();

	expect(hash).toBeDefined();
	expect(hash.length).toBe(8);
});

const composeFile4 = `
version: "3.8"

services:
  web:
    image: nginx:latest
    depends_on:
      - db
      - api

  api:
    image: myapi:latest

  db:
    image: postgres:latest

networks:
  default:
    driver: bridge
`;

test("Add suffix to service names with depends_on (array) in compose file", () => {
	const composeData = parse(composeFile4) as ComposeSpecification;

	const suffix = generateRandomHash();

	if (!composeData.services) {
		return;
	}
	const updatedComposeData = addSuffixToServiceNames(
		composeData.services,
		suffix,
	);
	const actualComposeData = { ...composeData, services: updatedComposeData };

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

	// Check that names in depends_on have the prefix
	expect(actualComposeData.services?.[`web-${suffix}`]?.depends_on).toContain(
		`db-${suffix}`,
	);
	expect(actualComposeData.services?.[`web-${suffix}`]?.depends_on).toContain(
		`api-${suffix}`,
	);

	// Check that the `db` and `api` services also have the prefix
	expect(actualComposeData.services).toHaveProperty(`db-${suffix}`);
	expect(actualComposeData.services).not.toHaveProperty("db");
	expect(actualComposeData.services?.[`db-${suffix}`]?.image).toBe(
		"postgres:latest",
	);
	expect(actualComposeData.services).toHaveProperty(`api-${suffix}`);
	expect(actualComposeData.services).not.toHaveProperty("api");
	expect(actualComposeData.services?.[`api-${suffix}`]?.image).toBe(
		"myapi:latest",
	);
});

const composeFile5 = `
version: "3.8"

services:
  web:
    image: nginx:latest
    depends_on:
      db:
        condition: service_healthy
      api:
        condition: service_started

  api:
    image: myapi:latest

  db:
    image: postgres:latest

networks:
  default:
    driver: bridge
`;

test("Add suffix to service names with depends_on (object) in compose file", () => {
	const composeData = parse(composeFile5) as ComposeSpecification;

	const suffix = generateRandomHash();

	if (!composeData.services) {
		return;
	}
	const updatedComposeData = addSuffixToServiceNames(
		composeData.services,
		suffix,
	);
	const actualComposeData = { ...composeData, services: updatedComposeData };

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

	// Check that names in depends_on have the prefix
	const webDependsOn = actualComposeData.services?.[`web-${suffix}`]
		?.depends_on as Record<string, any>;
	expect(webDependsOn).toHaveProperty(`db-${suffix}`);
	expect(webDependsOn).toHaveProperty(`api-${suffix}`);
	expect(webDependsOn[`db-${suffix}`].condition).toBe("service_healthy");
	expect(webDependsOn[`api-${suffix}`].condition).toBe("service_started");

	// Check that the `db` and `api` services also have the prefix
	expect(actualComposeData.services).toHaveProperty(`db-${suffix}`);
	expect(actualComposeData.services).not.toHaveProperty("db");
	expect(actualComposeData.services?.[`db-${suffix}`]?.image).toBe(
		"postgres:latest",
	);
	expect(actualComposeData.services).toHaveProperty(`api-${suffix}`);
	expect(actualComposeData.services).not.toHaveProperty("api");
	expect(actualComposeData.services?.[`api-${suffix}`]?.image).toBe(
		"myapi:latest",
	);
});

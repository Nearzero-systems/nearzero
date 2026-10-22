import type { ComposeSpecification } from "@nearzero/server";
import { addSuffixToServiceNames, generateRandomHash } from "@nearzero/server";
import { expect, test } from "vitest";
import { parse } from "yaml";

test("Generate random hash with 8 characters", () => {
	const hash = generateRandomHash();

	expect(hash).toBeDefined();
	expect(hash.length).toBe(8);
});

const composeFile6 = `
version: "3.8"

services:
  web:
    image: nginx:latest
    extends: base_service

  api:
    image: myapi:latest

  base_service:
    image: base:latest

networks:
  default:
    driver: bridge
`;

test("Add suffix to service names with extends (string) in compose file", () => {
	const composeData = parse(composeFile6) as ComposeSpecification;

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

	// Check that the name in extends has the prefix
	expect(actualComposeData.services?.[`web-${suffix}`]?.extends).toBe(
		`base_service-${suffix}`,
	);

	// Check that the `base_service` service also has the prefix
	expect(actualComposeData.services).toHaveProperty(`base_service-${suffix}`);
	expect(actualComposeData.services).not.toHaveProperty("base_service");
	expect(actualComposeData.services?.[`base_service-${suffix}`]?.image).toBe(
		"base:latest",
	);
});

const composeFile7 = `
version: "3.8"

services:
  web:
    image: nginx:latest
    extends:
      service: base_service
      file: docker-compose.base.yml

  api:
    image: myapi:latest

  base_service:
    image: base:latest

networks:
  default:
    driver: bridge
`;

test("Add suffix to service names with extends (object) in compose file", () => {
	const composeData = parse(composeFile7) as ComposeSpecification;

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

	// Check that the name in extends.service has the prefix
	const webExtends = actualComposeData.services?.[`web-${suffix}`]?.extends;
	if (typeof webExtends !== "string") {
		expect(webExtends?.service).toBe(`base_service-${suffix}`);
	}

	// Check that the `base_service` service also has the prefix
	expect(actualComposeData.services).toHaveProperty(`base_service-${suffix}`);
	expect(actualComposeData.services).not.toHaveProperty("base_service");
	expect(actualComposeData.services?.[`base_service-${suffix}`]?.image).toBe(
		"base:latest",
	);
});

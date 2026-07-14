import path from "node:path";
import { paths } from "@nearzero/server/constants";
import {
	getApplicationBuildDirectory,
	getBuildAppDirectory,
	getDockerContextPath,
} from "@nearzero/server/utils/filesystem/directory";
import { describe, expect, it } from "vitest";

const application = {
	appName: "path-containment-test",
	sourceType: "github",
	buildPath: "/apps/api",
	dockerfile: "Dockerfile",
	dockerContextPath: "/",
	buildType: "dockerfile",
} as any;

describe("application build path containment", () => {
	it("keeps normal build, Dockerfile, and context paths inside the checkout", () => {
		const sourceDirectory = path.join(
			paths(false).APPLICATIONS_PATH,
			application.appName,
			"code",
		);
		expect(getApplicationBuildDirectory(application, null)).toBe(
			path.join(sourceDirectory, "apps/api"),
		);
		expect(getBuildAppDirectory(application, null, "dockerfile")).toBe(
			path.join(sourceDirectory, "apps/api", "Dockerfile"),
		);
		expect(getDockerContextPath(application, null)).toBe(
			path.join(sourceDirectory, "/"),
		);
	});

	it("rejects build, Dockerfile, and context paths that escape the checkout", () => {
		expect(() =>
			getApplicationBuildDirectory(
				{ ...application, buildPath: "../../outside" },
				null,
			),
		).toThrow("Build path must stay inside the checked-out source directory.");
		expect(() =>
			getBuildAppDirectory(
				{ ...application, dockerfile: "../../../outside/Dockerfile" },
				null,
				"dockerfile",
			),
		).toThrow("Dockerfile path must stay inside the checked-out source directory.");
		expect(() =>
			getDockerContextPath(
				{ ...application, dockerContextPath: "../../outside" },
				null,
			),
		).toThrow("Docker context path must stay inside the checked-out source directory.");
	});
});

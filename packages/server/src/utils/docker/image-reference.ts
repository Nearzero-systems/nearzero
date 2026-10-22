/**
 * Docker image references: [registry[:port]/]path[:tag][@digest]. Rejecting
 * anything else (and a leading "-") keeps a user-supplied image from being
 * read as a shell fragment or a docker CLI flag.
 */
const DOCKER_IMAGE_REFERENCE = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]{0,254}$/;

export function isValidDockerImageReference(image: string): boolean {
	return DOCKER_IMAGE_REFERENCE.test(image.trim());
}

/** Shell command that pulls a user-supplied image on a remote host. */
export function dockerPullCommand(image: string): string {
	const trimmed = image.trim();
	if (!isValidDockerImageReference(trimmed)) {
		throw new Error(`Invalid Docker image reference: ${JSON.stringify(image)}`);
	}
	// The reference pattern excludes quotes, so single quotes are sufficient.
	return `docker pull '${trimmed}'`;
}

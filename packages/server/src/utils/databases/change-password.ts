const shellQuote = (value: string): string =>
	`'${value.replaceAll("'", `'"'"'`)}'`;

const sqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const sqlIdentifier = (value: string): string =>
	`"${value.replaceAll('"', '""')}"`;

const mysqlOptionValue = (value: string): string =>
	value
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("\r", "\\r")
		.replaceAll("\n", "\\n");

const runningContainerPrelude = (appName: string): string => `set -eu
app_name=${shellQuote(appName)}
CONTAINER_ID=$(docker ps -q --filter "status=running" --filter "label=com.docker.swarm.service.name=$app_name" | head -n 1)
if [ -z "$CONTAINER_ID" ]; then
	echo "No running database container found" >&2
	exit 1
fi`;

const buildMySqlFamilyPasswordChangeScript = ({
	appName,
	rootPassword,
	targetUser,
	newPassword,
	client,
}: {
	appName: string;
	rootPassword: string;
	targetUser: string;
	newPassword: string;
	client: "mysql" | "mariadb";
}): string => `${runningContainerPrelude(appName)}
docker exec -i "$CONTAINER_ID" sh -se <<'NEARZERO_INNER_SCRIPT'
set -eu
umask 077
credentials_file=$(mktemp)
cleanup() {
	rm -f "$credentials_file"
}
trap cleanup 0 1 2 3 15
cat > "$credentials_file" <<'NEARZERO_CLIENT_CONFIG'
[client]
password="${mysqlOptionValue(rootPassword)}"
NEARZERO_CLIENT_CONFIG
chmod 600 "$credentials_file"
${client} --defaults-extra-file="$credentials_file" --user=root --batch <<'NEARZERO_PASSWORD_SQL'
ALTER USER ${sqlString(targetUser)}@'%' IDENTIFIED BY ${sqlString(newPassword)};
FLUSH PRIVILEGES;
NEARZERO_PASSWORD_SQL
NEARZERO_INNER_SCRIPT
`;

export const buildMariaDbPasswordChangeScript = (input: {
	appName: string;
	rootPassword: string;
	targetUser: string;
	newPassword: string;
}): string =>
	buildMySqlFamilyPasswordChangeScript({ ...input, client: "mariadb" });

export const buildMySqlPasswordChangeScript = (input: {
	appName: string;
	rootPassword: string;
	targetUser: string;
	newPassword: string;
}): string =>
	buildMySqlFamilyPasswordChangeScript({ ...input, client: "mysql" });

export const buildMongoPasswordChangeScript = ({
	appName,
	databaseUser,
	oldPassword,
	newPassword,
}: {
	appName: string;
	databaseUser: string;
	oldPassword: string;
	newPassword: string;
}): string => `${runningContainerPrelude(appName)}
docker exec -i "$CONTAINER_ID" sh -se <<'NEARZERO_INNER_SCRIPT'
set -eu
umask 077
change_script=$(mktemp)
cleanup() {
	rm -f "$change_script"
}
trap cleanup 0 1 2 3 15
cat > "$change_script" <<'NEARZERO_MONGO_SCRIPT'
const adminDb = db.getSiblingDB("admin");
const authentication = adminDb.auth({
	user: ${JSON.stringify(databaseUser)},
	pwd: ${JSON.stringify(oldPassword)},
});
if (!authentication || authentication.ok !== 1) {
	throw new Error("Database authentication failed");
}
adminDb.changeUserPassword(
	${JSON.stringify(databaseUser)},
	${JSON.stringify(newPassword)},
);
NEARZERO_MONGO_SCRIPT
chmod 600 "$change_script"
mongosh --quiet --file "$change_script"
NEARZERO_INNER_SCRIPT
`;

export const buildRedisPasswordChangeScript = ({
	appName,
	oldPassword,
	newPassword,
}: {
	appName: string;
	oldPassword: string;
	newPassword: string;
}): string => `${runningContainerPrelude(appName)}
docker exec -i "$CONTAINER_ID" sh -se <<'NEARZERO_INNER_SCRIPT'
set -eu
export LC_ALL=C
old_password=${shellQuote(oldPassword)}
new_password=${shellQuote(newPassword)}
{
	printf '*2\r\n$4\r\nAUTH\r\n$%s\r\n%s\r\n' "\${#old_password}" "$old_password"
	printf '*4\r\n$6\r\nCONFIG\r\n$3\r\nSET\r\n$11\r\nrequirepass\r\n$%s\r\n%s\r\n' "\${#new_password}" "$new_password"
} | redis-cli --pipe --pipe-timeout 10
NEARZERO_INNER_SCRIPT
`;

export const buildPostgresPasswordChangeScript = ({
	appName,
	databaseUser,
	newPassword,
}: {
	appName: string;
	databaseUser: string;
	newPassword: string;
}): string => `${runningContainerPrelude(appName)}
database_user=${shellQuote(databaseUser)}
docker exec -i "$CONTAINER_ID" psql --set=ON_ERROR_STOP=1 --username "$database_user" <<'NEARZERO_PASSWORD_SQL'
ALTER USER ${sqlIdentifier(databaseUser)} WITH PASSWORD ${sqlString(newPassword)};
NEARZERO_PASSWORD_SQL
`;

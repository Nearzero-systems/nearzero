export type DatabaseServiceVariant =
	| "postgres"
	| "mysql"
	| "mongo"
	| "redis"
	| "mariadb"
	| "libsql";

export type DatabaseVariantConfig = {
	idField: string;
	label: string;
	deployTitle: string;
	deployDescription: string;
	reloadTitle: string;
	reloadDescription: string;
	startTitle: string;
	startDescription: string;
	stopTitle: string;
	stopDescription: string;
	deployTooltip: string;
	reloadTooltip: string;
	startTooltip: string;
	stopTooltip: string;
	terminalTooltip: string;
	deploySuccess: string;
	reloadSuccess: string;
	startSuccess: string;
	stopSuccess: string;
	deployError: string;
	reloadError: string;
	startError: string;
	stopError: string;
};

export const DATABASE_VARIANT_CONFIG: Record<
	DatabaseServiceVariant,
	DatabaseVariantConfig
> = {
	postgres: {
		idField: "postgresId",
		label: "PostgreSQL",
		deployTitle: "Deploy PostgreSQL",
		deployDescription: "Are you sure you want to deploy this postgres?",
		reloadTitle: "Reload PostgreSQL",
		reloadDescription: "Are you sure you want to reload this postgres?",
		startTitle: "Start PostgreSQL",
		startDescription: "Are you sure you want to start this postgres?",
		stopTitle: "Stop PostgreSQL",
		stopDescription: "Are you sure you want to stop this postgres?",
		deployTooltip: "Downloads and sets up the PostgreSQL database",
		reloadTooltip: "Restart the PostgreSQL service without rebuilding",
		startTooltip:
			"Start the PostgreSQL database (requires a previous successful setup)",
		stopTooltip: "Stop the currently running PostgreSQL database",
		terminalTooltip: "Open a terminal to the PostgreSQL container",
		deploySuccess: "PostgreSQL deployed successfully",
		reloadSuccess: "PostgreSQL reloaded successfully",
		startSuccess: "PostgreSQL started successfully",
		stopSuccess: "PostgreSQL stopped successfully",
		deployError: "Error deploying PostgreSQL",
		reloadError: "Error reloading PostgreSQL",
		startError: "Error starting PostgreSQL",
		stopError: "Error stopping PostgreSQL",
	},
	mysql: {
		idField: "mysqlId",
		label: "MySQL",
		deployTitle: "Deploy MySQL",
		deployDescription: "Are you sure you want to deploy this mysql?",
		reloadTitle: "Reload MySQL",
		reloadDescription: "Are you sure you want to reload this mysql?",
		startTitle: "Start MySQL",
		startDescription: "Are you sure you want to start this mysql?",
		stopTitle: "Stop MySQL",
		stopDescription: "Are you sure you want to stop this mysql?",
		deployTooltip: "Downloads and sets up the MySQL database",
		reloadTooltip: "Restart the MySQL service without rebuilding",
		startTooltip:
			"Start the MySQL database (requires a previous successful setup)",
		stopTooltip: "Stop the currently running MySQL database",
		terminalTooltip: "Open a terminal to the MySQL container",
		deploySuccess: "MySQL deployed successfully",
		reloadSuccess: "MySQL reloaded successfully",
		startSuccess: "MySQL started successfully",
		stopSuccess: "MySQL stopped successfully",
		deployError: "Error deploying MySQL",
		reloadError: "Error reloading MySQL",
		startError: "Error starting MySQL",
		stopError: "Error stopping MySQL",
	},
	mongo: {
		idField: "mongoId",
		label: "MongoDB",
		deployTitle: "Deploy MongoDB",
		deployDescription: "Are you sure you want to deploy this mongo?",
		reloadTitle: "Reload MongoDB",
		reloadDescription: "Are you sure you want to reload this mongo?",
		startTitle: "Start MongoDB",
		startDescription: "Are you sure you want to start this mongo?",
		stopTitle: "Stop MongoDB",
		stopDescription: "Are you sure you want to stop this mongo?",
		deployTooltip: "Downloads and sets up the MongoDB database",
		reloadTooltip: "Restart the MongoDB service without rebuilding",
		startTooltip:
			"Start the MongoDB database (requires a previous successful setup)",
		stopTooltip: "Stop the currently running MongoDB database",
		terminalTooltip: "Open a terminal to the MongoDB container",
		deploySuccess: "MongoDB deployed successfully",
		reloadSuccess: "MongoDB reloaded successfully",
		startSuccess: "MongoDB started successfully",
		stopSuccess: "MongoDB stopped successfully",
		deployError: "Error deploying MongoDB",
		reloadError: "Error reloading MongoDB",
		startError: "Error starting MongoDB",
		stopError: "Error stopping MongoDB",
	},
	redis: {
		idField: "redisId",
		label: "Redis",
		deployTitle: "Deploy Redis",
		deployDescription: "Are you sure you want to deploy this redis?",
		reloadTitle: "Reload Redis",
		reloadDescription: "Are you sure you want to reload this redis?",
		startTitle: "Start Redis",
		startDescription: "Are you sure you want to start this redis?",
		stopTitle: "Stop Redis",
		stopDescription: "Are you sure you want to stop this redis?",
		deployTooltip: "Downloads and sets up the Redis database",
		reloadTooltip: "Restart the Redis service without rebuilding",
		startTooltip:
			"Start the Redis database (requires a previous successful setup)",
		stopTooltip: "Stop the currently running Redis database",
		terminalTooltip: "Open a terminal to the Redis container",
		deploySuccess: "Redis deployed successfully",
		reloadSuccess: "Redis reloaded successfully",
		startSuccess: "Redis started successfully",
		stopSuccess: "Redis stopped successfully",
		deployError: "Error deploying Redis",
		reloadError: "Error reloading Redis",
		startError: "Error starting Redis",
		stopError: "Error stopping Redis",
	},
	mariadb: {
		idField: "mariadbId",
		label: "MariaDB",
		deployTitle: "Deploy MariaDB",
		deployDescription: "Are you sure you want to deploy this mariadb?",
		reloadTitle: "Reload MariaDB",
		reloadDescription: "Are you sure you want to reload this mariadb?",
		startTitle: "Start MariaDB",
		startDescription: "Are you sure you want to start this mariadb?",
		stopTitle: "Stop MariaDB",
		stopDescription: "Are you sure you want to stop this mariadb?",
		deployTooltip: "Downloads and sets up the MariaDB database",
		reloadTooltip: "Restart the MariaDB service without rebuilding",
		startTooltip:
			"Start the MariaDB database (requires a previous successful setup)",
		stopTooltip: "Stop the currently running MariaDB database",
		terminalTooltip: "Open a terminal to the MariaDB container",
		deploySuccess: "MariaDB deployed successfully",
		reloadSuccess: "MariaDB reloaded successfully",
		startSuccess: "MariaDB started successfully",
		stopSuccess: "MariaDB stopped successfully",
		deployError: "Error deploying MariaDB",
		reloadError: "Error reloading MariaDB",
		startError: "Error starting MariaDB",
		stopError: "Error stopping MariaDB",
	},
	libsql: {
		idField: "libsqlId",
		label: "libSQL",
		deployTitle: "Deploy libSQL",
		deployDescription: "Are you sure you want to deploy this libsql?",
		reloadTitle: "Reload libSQL",
		reloadDescription: "Are you sure you want to reload this libsql?",
		startTitle: "Start libSQL",
		startDescription: "Are you sure you want to start this libsql?",
		stopTitle: "Stop libSQL",
		stopDescription: "Are you sure you want to stop this libsql?",
		deployTooltip: "Downloads and sets up the libSQL database",
		reloadTooltip: "Restart the libSQL service without rebuilding",
		startTooltip:
			"Start the libSQL database (requires a previous successful setup)",
		stopTooltip: "Stop the currently running libSQL database",
		terminalTooltip: "Open a terminal to the libSQL container",
		deploySuccess: "libSQL deployed successfully",
		reloadSuccess: "libSQL reloaded successfully",
		startSuccess: "libSQL started successfully",
		stopSuccess: "libSQL stopped successfully",
		deployError: "Error deploying libSQL",
		reloadError: "Error reloading libSQL",
		startError: "Error starting libSQL",
		stopError: "Error stopping libSQL",
	},
};

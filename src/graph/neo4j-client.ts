import neo4j, { type AuthToken, type Config, type Driver, type ManagedTransaction, type QueryResult } from "neo4j-driver";

export interface Neo4jSettings {
  uri: string;
  username: string;
  password?: string;
  database: string;
}

export function neo4jSettingsFromEnv(): Neo4jSettings {
  return {
    uri: process.env.NEO4J_URI ?? "bolt://localhost:7687",
    username: process.env.NEO4J_USERNAME ?? "neo4j",
    password: process.env.NEO4J_PASSWORD,
    database: process.env.NEO4J_DATABASE ?? "neo4j",
  };
}

export type DriverFactory = (uri: string, auth: AuthToken, config: Config) => Driver;

const defaultDriverFactory: DriverFactory = (uri, auth, config) => neo4j.driver(uri, auth, config);

export const FULLTEXT_INDEX = "node_text_idx";

export class Neo4jClient {
  private driver: Driver | null = null;
  private connecting: Promise<Driver> | null = null;

  constructor(
    private readonly settings: Neo4jSettings = neo4jSettingsFromEnv(),
    private readonly createDriver: DriverFactory = defaultDriverFactory,
  ) {}

  async connect(): Promise<void> {
    await this.getDriver();
  }

  isConnected(): boolean {
    return this.driver !== null;
  }

  async run(cypher: string, params: Record<string, unknown> = {}): Promise<QueryResult> {
    const driver = await this.getDriver();
    const session = driver.session({ database: this.settings.database });
    try {
      return await session.run(cypher, params);
    } finally {
      await session.close();
    }
  }

  async writeTransaction<T>(work: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
    const driver = await this.getDriver();
    const session = driver.session({ database: this.settings.database });
    try {
      return await session.executeWrite(work);
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    const driver = this.driver;
    this.driver = null;
    if (driver) await driver.close();
  }

  private getDriver(): Promise<Driver> {
    if (this.driver) return Promise.resolve(this.driver);
    this.connecting ??= this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async open(): Promise<Driver> {
    const { uri, username, password, database } = this.settings;
    if (!password) throw new Error("NEO4J_PASSWORD is required to connect to Neo4j. Set it in .env (see .env.example).");

    const driver = this.createDriver(uri, neo4j.auth.basic(username, password), { disableLosslessIntegers: true });
    try {
      await driver.verifyConnectivity({ database });
      await this.initializeSchema(driver);
    } catch (error) {
      await driver.close().catch(() => undefined);
      throw new Error(`Could not connect to Neo4j at ${uri}: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.driver = driver;
    return driver;
  }

  private async initializeSchema(driver: Driver): Promise<void> {
    const session = driver.session({ database: this.settings.database });
    try {
      const legacy = await session.run(
        "SHOW CONSTRAINTS YIELD name, labelsOrTypes, properties WHERE labelsOrTypes = ['Node'] AND properties = ['canonicalName'] RETURN name",
      );
      for (const record of legacy.records) {
        await session.run(`DROP CONSTRAINT \`${String(record.get("name")).replace(/`/g, "")}\` IF EXISTS`);
      }
      await session.run("CREATE CONSTRAINT node_id_unique IF NOT EXISTS FOR (n:Node) REQUIRE n.id IS UNIQUE");
      await session.run("CREATE INDEX node_type_idx IF NOT EXISTS FOR (n:Node) ON (n.nodeType)");
      await session.run("CREATE INDEX node_canonical_name_idx IF NOT EXISTS FOR (n:Node) ON (n.canonicalName)");
      await session.run(
        `CREATE FULLTEXT INDEX ${FULLTEXT_INDEX} IF NOT EXISTS FOR (n:Node) ON EACH [n.canonicalName, n.title, n.aliasText, n.description]`,
      );
    } finally {
      await session.close();
    }
  }
}

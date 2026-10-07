import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import OpenAI from "openai";
import { hash, required } from "../core/runtime.js";

export type SourceDocument = { id: string; kind: string; title: string; text: string; sourcePath: string };
export type SearchHit = { documentId: string; sourcePath: string; text: string; score: number };

const schema = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, source_path TEXT NOT NULL, document_type TEXT NOT NULL,
  title TEXT, content_hash TEXT NOT NULL, metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  text TEXT NOT NULL, section TEXT, page INTEGER, content_hash TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS chunk_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS document_type TEXT;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS source_path TEXT;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS node_id TEXT;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS node_type TEXT;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(section, '') || ' ' || text)) STORED;
CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);
CREATE TABLE IF NOT EXISTS ingestion_runs (
  id TEXT PRIMARY KEY, source_path TEXT NOT NULL, status TEXT NOT NULL,
  documents_processed INTEGER DEFAULT 0, chunks_created INTEGER DEFAULT 0,
  nodes_created INTEGER DEFAULT 0, edges_created INTEGER DEFAULT 0,
  embeddings_created INTEGER DEFAULT 0, started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ, metadata JSONB DEFAULT '{}'
);`;

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function chunksOf(text: string): string[] {
  const chunks: string[] = [];
  const normalized = text.trim();
  for (let start = 0; start < normalized.length; start += 1400) {
    chunks.push(normalized.slice(start, start + 1600));
  }
  return chunks;
}

export class PostgresDocuments {
  private pool: pg.Pool;
  private dimensions: number;
  private modelName: string;

  constructor() {
    const caPath = required("POSTGRES_CA_PATH");
    const ca = fs.readFileSync(path.resolve(caPath), "utf8");
    this.dimensions = positiveInteger("EMBEDDING_DIMENSIONS", 1536);
    this.modelName = process.env.OPENROUTER_EMBEDDING_MODEL ?? "openai/text-embedding-3-small";
    this.pool = new pg.Pool({
      host: required("POSTGRES_HOST"),
      port: positiveInteger("POSTGRES_PORT", 5432),
      database: required("POSTGRES_DATABASE"),
      user: required("POSTGRES_USER"),
      password: required("POSTGRES_PASSWORD"),
      ssl: { ca, rejectUnauthorized: false },
      max: 4,
      connectionTimeoutMillis: 10000,
    });
  }

  async close(): Promise<void> { await this.pool.end(); }

  async check(): Promise<string> {
    const result = await this.pool.query<{ version: string }>("SELECT version()");
    return result.rows[0].version;
  }

  async readText(documentId: string): Promise<string | null> {
    const result = await this.pool.query<{ text: string }>(
      "SELECT text FROM chunks WHERE document_id = $1 ORDER BY chunk_index", [documentId]);
    if (!result.rows.length) return null;
    return result.rows.map((row, index) => index === 0 ? row.text : row.text.slice(200)).join("");
  }

  async setup(): Promise<void> {
    await this.pool.query(schema);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS embeddings (
      id TEXT PRIMARY KEY, chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      node_id TEXT, embedding vector(${this.dimensions}) NOT NULL,
      model TEXT NOT NULL, embedding_text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await this.pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_chunk_model ON embeddings(chunk_id, model)");
    if (this.dimensions <= 2000) await this.pool.query("CREATE INDEX IF NOT EXISTS idx_embeddings_hnsw ON embeddings USING hnsw (embedding vector_cosine_ops)");
  }

  private async embed(text: string): Promise<number[]> {
    const client = new OpenAI({ apiKey: required("OPENROUTER_API_KEY"), baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1" });
    const result = await client.embeddings.create({ model: this.modelName, input: text });
    const embedding = result.data[0]?.embedding;
    if (!embedding || embedding.length !== this.dimensions || !embedding.every(Number.isFinite)) {
      throw new Error(`Embedding model ${this.modelName} did not return ${this.dimensions} finite values`);
    }
    return embedding;
  }

  async upsert(document: SourceDocument): Promise<number> {
    const text = document.text.trim();
    if (!text) return 0;
    const contentHash = hash(text);
    const previous = await this.pool.query<{ content_hash: string }>("SELECT content_hash FROM documents WHERE id = $1", [document.id]);
    if (previous.rows[0]?.content_hash === contentHash) return 0;
    const pieces = chunksOf(text);
    const embeddings: number[][] = [];
    for (const piece of pieces) embeddings.push(await this.embed(piece));
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO documents (id, source_path, document_type, title, content_hash)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET source_path=EXCLUDED.source_path,
        document_type=EXCLUDED.document_type, title=EXCLUDED.title, content_hash=EXCLUDED.content_hash, updated_at=NOW()`,
        [document.id, document.sourcePath, document.kind, document.title, contentHash]);
      await client.query("DELETE FROM chunks WHERE document_id = $1", [document.id]);
      for (let index = 0; index < pieces.length; index++) {
        const chunkId = hash(`${document.id}:${index}:${pieces[index]}`);
        await client.query(`INSERT INTO chunks (id, document_id, text, content_hash, chunk_index, document_type, source_path, node_id, node_type)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [chunkId, document.id, pieces[index], hash(pieces[index]), index, document.kind, document.sourcePath, document.id, document.kind]);
        await client.query(`INSERT INTO embeddings (id, chunk_id, node_id, embedding, model, embedding_text)
          VALUES ($1,$2,$3,$4::vector,$5,$6)`,
          [hash(`${chunkId}:${this.modelName}`), chunkId, document.id, `[${embeddings[index].join(",")}]`, this.modelName, pieces[index]]);
      }
      await client.query("COMMIT");
      return pieces.length;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async search(query: string, limit = 10): Promise<SearchHit[]> {
    if (!query.trim()) return [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("Search limit must be 1 to 50");
    const embedding = await this.embed(query);
    const result = await this.pool.query<{ document_id: string; source_path: string; text: string; score: number }>(`
      SELECT c.document_id, c.source_path, c.text,
        ts_rank_cd(c.tsv, websearch_to_tsquery('english', $1)) +
        (1 - (e.embedding <=> $2::vector)) AS score
      FROM chunks c JOIN embeddings e ON e.chunk_id = c.id
      WHERE e.model = $3
      ORDER BY score DESC LIMIT $4`, [query, `[${embedding.join(",")}]`, this.modelName, limit]);
    return result.rows.map((row) => ({ documentId: row.document_id, sourcePath: row.source_path, text: row.text, score: Number(row.score) }));
  }
}

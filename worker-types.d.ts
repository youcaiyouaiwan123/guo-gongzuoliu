declare module "cloudflare:workers" {
  export const env: Record<string, unknown> & {
    DB?: D1Database;
    FILES?: R2Bucket;
    AI?: Fetcher;
  };
}

type D1Value = ArrayBuffer | string | number | null;
type D1Row = Record<string, D1Value>;

type D1Result<T = D1Row> = {
  results: T[];
  success?: boolean;
  meta?: unknown;
};

type D1RunResult = {
  success?: boolean;
  meta: {
    changes?: number;
    last_row_id?: number;
    duration?: number;
    rows_read?: number;
    rows_written?: number;
  };
};

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = D1Row>(): Promise<T | null>;
  all<T = D1Row>(): Promise<D1Result<T>>;
  run(): Promise<D1RunResult>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = D1Row>(statements: D1PreparedStatement[]): Promise<Array<D1Result<T>>>;
  exec(query: string): Promise<unknown>;
}

interface R2ObjectBody {
  body: ReadableStream;
  httpEtag?: string;
  writeHttpMetadata(headers: Headers): void;
}

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
    options?: unknown
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
}

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

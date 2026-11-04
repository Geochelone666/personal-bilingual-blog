import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

/** Minimal D1 API shim over better-sqlite3 for local tests (prepare/bind/first/all/run/batch). */
export function makeD1(): any {
  const db = new Database(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  class Stmt {
    constructor(public sql: string, public args: unknown[] = []) {}
    bind(...a: unknown[]) {
      return new Stmt(this.sql, a.map((x) => (x === undefined ? null : x)));
    }
    async first<T>() {
      return (db.prepare(this.sql).get(...this.args) as T) ?? null;
    }
    async all<T>() {
      return { results: db.prepare(this.sql).all(...this.args) as T[] };
    }
    async run() {
      const r = db.prepare(this.sql).run(...this.args);
      return { meta: { changes: r.changes } };
    }
    _runSync() {
      const r = db.prepare(this.sql).run(...this.args);
      return { meta: { changes: r.changes } };
    }
  }
  return {
    raw: db,
    prepare: (sql: string) => new Stmt(sql),
    batch: async (stmts: Stmt[]) => db.transaction(() => stmts.map((s) => s._runSync()))(),
  };
}

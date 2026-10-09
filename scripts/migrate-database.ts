import "dotenv/config";
import { Client } from "pg";
import { spawn } from "node:child_process";

const sourceUrl = process.env.DATABASE_URL;
const targetUrl = process.env.TARGET_DATABASE_URL;

function sameUrl(a?: string, b?: string) {
  if (!a || !b) return false;
  try {
    const x = new URL(a);
    const y = new URL(b);
    x.password = "";
    y.password = "";
    return x.toString() === y.toString();
  } catch {
    return a === b;
  }
}

function qi(name: string) {
  return '"' + name.replaceAll('"', '""') + '"';
}

async function runPrismaMigrations(url: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npx", ["prisma", "migrate", "deploy"], {
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: url },
    });
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`prisma migrate deploy exited with ${code}`)));
    child.on("error", reject);
  });
}

async function getTables(client: Client) {
  const { rows } = await client.query(`
    select tablename
    from pg_tables
    where schemaname = 'public'
      and tablename <> '_prisma_migrations'
    order by tablename
  `);
  return rows.map((r) => r.tablename as string);
}

async function getDependencyOrder(client: Client, tables: string[]) {
  const tableSet = new Set(tables);
  const { rows } = await client.query(`
    select
      child.relname as child,
      parent.relname as parent
    from pg_constraint c
    join pg_class child on child.oid = c.conrelid
    join pg_class parent on parent.oid = c.confrelid
    join pg_namespace n on n.oid = child.relnamespace
    where c.contype = 'f'
      and n.nspname = 'public'
  `);

  const deps = new Map<string, Set<string>>();
  for (const t of tables) deps.set(t, new Set());
  for (const r of rows) {
    if (tableSet.has(r.child) && tableSet.has(r.parent) && r.child !== r.parent) {
      deps.get(r.child)!.add(r.parent);
    }
  }

  const out: string[] = [];
  const remaining = new Set(tables);
  while (remaining.size) {
    const ready = [...remaining].filter((t) => [...(deps.get(t) ?? [])].every((d) => !remaining.has(d)));
    if (!ready.length) {
      out.push(...[...remaining].sort());
      break;
    }
    ready.sort();
    for (const t of ready) {
      out.push(t);
      remaining.delete(t);
    }
  }
  return out;
}

async function getColumns(client: Client, table: string) {
  const { rows } = await client.query(`
    select column_name
    from information_schema.columns
    where table_schema = 'public' and table_name = $1
    order by ordinal_position
  `, [table]);
  return rows.map((r) => r.column_name as string);
}

async function copyTable(source: Client, target: Client, table: string) {
  const columns = await getColumns(source, table);
  if (!columns.length) return 0;

  const result = await source.query(`select * from ${qi(table)}`);
  const rows = result.rows;
  if (!rows.length) return 0;

  const colSql = columns.map(qi).join(", ");
  const batchSize = 100;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const values: unknown[] = [];
    const groups: string[] = [];
    for (const row of batch) {
      const placeholders: string[] = [];
      for (const col of columns) {
        values.push(row[col]);
        placeholders.push("$" + values.length);
      }
      groups.push("(" + placeholders.join(", ") + ")");
    }
    await target.query(
      `insert into ${qi(table)} (${colSql}) values ${groups.join(", ")}`,
      values,
    );
  }
  return rows.length;
}

async function main() {
  if (!sourceUrl || !targetUrl) {
    console.log("[DB Migration] TARGET_DATABASE_URL not configured; skipping.");
    return;
  }
  if (sameUrl(sourceUrl, targetUrl)) {
    console.log("[DB Migration] Source and target are the same database; skipping.");
    return;
  }

  console.log("[DB Migration] Preparing target schema...");
  await runPrismaMigrations(targetUrl);

  const source = new Client({ connectionString: sourceUrl });
  const target = new Client({ connectionString: targetUrl });

  await source.connect();
  await target.connect();

  try {
    await source.query("begin isolation level repeatable read read only");
    await target.query("begin");

    const sourceTables = await getTables(source);
    const targetTables = new Set(await getTables(target));
    const tables = sourceTables.filter((t) => targetTables.has(t));
    const order = await getDependencyOrder(source, tables);

    if (!tables.length) throw new Error("No application tables found to migrate.");

    console.log(`[DB Migration] Migrating ${tables.length} tables...`);

    await target.query(
      "truncate table " + order.map(qi).join(", ") + " restart identity cascade"
    );

    const copied = new Map<string, number>();
    for (const table of order) {
      const count = await copyTable(source, target, table);
      copied.set(table, count);
      console.log(`[DB Migration] ${table}: copied ${count} rows`);
    }

    for (const table of order) {
      const src = Number((await source.query(`select count(*)::bigint as c from ${qi(table)}`)).rows[0].c);
      const dst = Number((await target.query(`select count(*)::bigint as c from ${qi(table)}`)).rows[0].c);
      if (src !== dst || dst !== copied.get(table)) {
        throw new Error(`Row count mismatch for ${table}: source=${src}, target=${dst}, copied=${copied.get(table)}`);
      }
    }

    await target.query("commit");
    await source.query("commit");
    console.log("[DB Migration] COMPLETE: all table row counts verified.");
  } catch (error) {
    try { await target.query("rollback"); } catch {}
    try { await source.query("rollback"); } catch {}
    throw error;
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch((error) => {
  console.error("[DB Migration] FAILED", error);
  process.exit(1);
});

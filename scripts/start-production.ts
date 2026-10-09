import "dotenv/config";
import { spawn } from "node:child_process";

function run(command: string, args: string[], env = process.env) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
    child.on("error", reject);
  });
}

async function main() {
  const source = process.env.DATABASE_URL;
  const target = process.env.TARGET_DATABASE_URL;

  if (target && source && target !== source) {
    console.log("[Startup] Target database configured. Running one-time migration...");
    await run("npx", ["tsx", "scripts/migrate-database.ts"]);
  }

  const effectiveDatabaseUrl = target || source;
  if (!effectiveDatabaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const env = { ...process.env, DATABASE_URL: effectiveDatabaseUrl };

  console.log("[Startup] Applying Prisma migrations to active database...");
  await run("npx", ["prisma", "migrate", "deploy"], env);

  console.log("[Startup] Starting OpenReply...");
  await run("npx", ["next", "start"], env);
}

main().catch((error) => {
  console.error("[Startup] FAILED", error);
  process.exit(1);
});

declare global {
  // eslint-disable-next-line no-var
  var __openreplyEmbeddedWorkerStarted: boolean | undefined;
}

export async function register() {
  const isRuntime =
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NEXT_PHASE !== "phase-production-build" &&
    process.env.ENABLE_EMBEDDED_WORKER === "true";

  if (!isRuntime || globalThis.__openreplyEmbeddedWorkerStarted) return;

  globalThis.__openreplyEmbeddedWorkerStarted = true;
  await import("./worker/dm-worker");
}

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Lightweight process liveness probe for hosting platforms.
 *
 * This intentionally does not depend on Postgres, Redis, or the background
 * worker. The strict end-to-end readiness check remains /api/health.
 */
export async function GET() {
  return NextResponse.json({ status: "ok" }, { status: 200 });
}

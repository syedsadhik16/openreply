import { prisma } from '@/lib/db/client';
import { getDMQueue, getRedisConnection, MESSAGE_JOB_NAME, POSTBACK_JOB_NAME } from '@/lib/queue/client';
import { parseCommentEvents, parseMessageEvents, parsePostbackEvents, parseReadEvents } from '@/lib/meta/webhook';
import { Prisma, type InstagramProvider } from '@/app/generated/prisma/client';

const OPENING_DM_READ_FALLBACK_DELAY_MS = 5 * 60 * 1000;
const OPENING_DM_READ_FALLBACK_MAX_AGE_MS = 15 * 60 * 1000;
const READ_FALLBACK_SUPPRESSION_TTL_SECONDS = 15 * 60;

function readFallbackSuppressionKey(instagramAccountId: string, userId: string) {
  return `openreply:read-fallback-suppress:${instagramAccountId}:${userId}`;
}
type InstagramPayload = Parameters<typeof parseCommentEvents>[0];

export async function processInstagramWebhook({ payload: incoming, provider, workspaceId }: {
  payload: InstagramPayload; provider: InstagramProvider; workspaceId?: string;
}) {
  if (incoming.object !== 'instagram' || !Array.isArray(incoming.entry)) return;
  const accounts = await prisma.instagramAccount.findMany({
    where: { instagramId: { in: incoming.entry.map(e => e.id) }, provider, ...(workspaceId ? { workspaceId } : {}) },
    select: { id: true, instagramId: true, workspaceId: true },
  });
  const accountMap = new Map(accounts.map(a => [a.instagramId, a]));
  const allowed = new Set(accountMap.keys());
  const payload = { ...incoming, entry: incoming.entry.filter(e => allowed.has(e.id)) };
  if (!payload.entry.length) return;
  const webhookEvent = await prisma.webhookEvent.create({
    data: {
      object:
        typeof payload === "object" && payload && "object" in payload
          ? String(payload.object)
          : null,
      payload: payload as unknown as Prisma.InputJsonValue,
      ...(workspaceId ? { workspaceId } : {}),
      status: "PENDING",
    },
  });

  try {
    const commentEvents = parseCommentEvents(
      payload as Parameters<typeof parseCommentEvents>[0]
    );
    const queue = getDMQueue();

    for (const event of commentEvents) {
      const account = accountMap.get(event.instagramAccountId);
      if (!account) continue;

      await queue.add(
        "process-comment",
        {
          instagramAccountId: event.instagramAccountId,
          accountConnectionId: accountMap.get(event.instagramAccountId)?.id,
          commentId: event.commentId,
          commentText: event.commentText,
          commenterId: event.commenterId,
          commenterName: event.commenterName,
          mediaId: event.mediaId,
          originalMediaId: event.originalMediaId,
          source: "WEBHOOK",
        },
        {
          jobId: `comment_${event.instagramAccountId}_${event.commentId}`,
        }
      );

      if (account) {
        await prisma.webhookEvent.update({
          where: { id: webhookEvent.id },
          data: { workspaceId: account.workspaceId },
        });
      }
    }

    // Button taps from opening DMs → deliver the reveal message.
    const postbackEvents = parsePostbackEvents(
      payload as Parameters<typeof parsePostbackEvents>[0]
    );

    for (const event of postbackEvents) {
      await queue.add(
        POSTBACK_JOB_NAME,
        {
          instagramAccountId: event.instagramAccountId,
          accountConnectionId: accountMap.get(event.instagramAccountId)?.id,
          userId: event.userId,
          payload: event.payload,
          mid: event.mid,
        },
        {
          // BullMQ forbids ":" in custom job ids, and the payload is
          // "reveal:<id>", so build with underscores and strip any colons.
          jobId: `postback_${event.instagramAccountId}_${event.userId}_${(
            event.mid ?? event.payload
          ).replace(/:/g, "_")}`,
        }
      );
    }

    // Inbound DMs → keyword-triggered autoreply.
    const messageEvents = parseMessageEvents(
      payload as Parameters<typeof parseMessageEvents>[0]
    );

    for (const event of messageEvents) {
      const account = accountMap.get(event.instagramAccountId);
      if (!account) continue;

      // Any real inbound DM means the user is actively conversing with us.
      // Suppress delayed read-fallback reveals for a short window so an old
      // opening DM cannot inject a stale link into a live conversation.
      await getRedisConnection()
        .set(
          readFallbackSuppressionKey(event.instagramAccountId, event.senderId),
          "1",
          "EX",
          READ_FALLBACK_SUPPRESSION_TTL_SECONDS
        )
        .catch(() => {});

      await queue.add(
        MESSAGE_JOB_NAME,
        {
          instagramAccountId: event.instagramAccountId,
          accountConnectionId: accountMap.get(event.instagramAccountId)?.id,
          messageId: event.messageId,
          messageText: event.messageText,
          senderId: event.senderId,
        },
        {
          // Message ids can contain characters BullMQ rejects in a job id (":"
          // in particular). base64url encodes into exactly the allowed alphabet
          // and stays injective — substituting invalid characters would let two
          // distinct mids collapse onto one job id, silently dropping a reply.
          jobId: `message_${event.instagramAccountId}_${Buffer.from(
            event.messageId
          ).toString("base64url")}`,
        }
      );

      if (account) {
        await prisma.webhookEvent.update({
          where: { id: webhookEvent.id },
          data: { workspaceId: account.workspaceId },
        });
      }
    }

    // If a user reads the opening DM and never taps the button, deliver the
    // same next-step DM after five minutes. The worker no-ops this delayed job
    // if a real button tap has already delivered the reveal.
    const readEvents = parseReadEvents(
      payload as Parameters<typeof parseReadEvents>[0]
    );

    for (const event of readEvents) {
      // A read receipt belongs to the conversation, not to a specific campaign.
      // The old code looked up every SENT campaign this user had ever touched
      // and scheduled a fallback for all of them, which could dump several old
      // "Click and Open" messages into the same inbox at once.
      //
      // Only the most recent *opening-DM* send is eligible, and only while it is
      // still fresh. Reveal/postback and DM-trigger log rows are explicitly
      // excluded.
      const latestOpeningLog = await prisma.dmLog.findFirst({
        where: {
          commenterId: event.userId,
          status: "SENT",
          dmSentAt: {
            gte: new Date(Date.now() - OPENING_DM_READ_FALLBACK_MAX_AGE_MS),
          },
          NOT: [
            { commentId: { startsWith: "reveal:" } },
            { commentId: { startsWith: "dm:" } },
          ],
          automation: {
            isActive: true,
            openingDmEnabled: true,
            instagramAccount: {
              instagramId: event.instagramAccountId,
            },
          },
        },
        orderBy: { dmSentAt: "desc" },
        select: {
          automation: {
            select: {
              id: true,
            },
          },
        },
      });

      if (!latestOpeningLog) continue;

      const automationId = latestOpeningLog.automation.id;
      await queue.add(
        POSTBACK_JOB_NAME,
        {
          instagramAccountId: event.instagramAccountId,
          accountConnectionId: accountMap.get(event.instagramAccountId)?.id,
          userId: event.userId,
          payload: `reveal:${automationId}`,
          fallback: true,
        },
        {
          delay: OPENING_DM_READ_FALLBACK_DELAY_MS,
          jobId: `read_fallback_${event.instagramAccountId}_${event.userId}_${automationId}`,
        }
      );
    }

    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        status: "PROCESSED",
        processedAt: new Date(),
      },
    });

    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        status: "FAILED",
        errorMessage: message,
        processedAt: new Date(),
      },
    });

    throw error;
  }
}

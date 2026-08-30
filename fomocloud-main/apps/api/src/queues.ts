import { Queue } from "bullmq";
import { Redis } from "ioredis";

// Single shared Redis connection + queue instances -- server.ts and any extracted route module
// (e.g. walletRoutes.ts) import from here rather than each opening their own BullMQ Queue client
// against the same named queue.
export const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1 });
export const broadcastQueue = new Queue("broadcasts", { connection: redis });
export const notificationQueue = new Queue("user-notifications", { connection: redis });

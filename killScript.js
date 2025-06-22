const Bull = require("bull");
const express = require("express");
const app = express();

const taskQueue = new Bull("task-queue", {
  redis: {
    host: process.env.HOST,
    port: 15237,
    password: process.env.REDISPASS,
    enableReadyCheck: false,
  },
  limiter: {
    max: 5,
    duration: 1000,
  },
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false,
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
  },
  settings: {
    lockDuration: 600000,
    maxStalledCount: 3,
  },
});

// 🚫 DESTROYS EVERYTHING
async function killAll() {
  try {
    console.log("Pausing queue...");
    await taskQueue.pause(true);

    console.log("Failing active jobs...");
    const activeJobs = await taskQueue.getActive();
    for (const job of activeJobs) {
      await job.moveToFailed(new Error("Force killed"), true);
    }

    console.log("Obliterating queue...");
    await taskQueue.obliterate({ force: true });

    console.log("Closing queue and Redis...");
    await taskQueue.close();
    if (taskQueue.client && taskQueue.client.disconnect) {
      await taskQueue.client.disconnect();
    }

    console.log("✅ All tasks killed and connections closed.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Shutdown failed:", err);
    process.exit(1);
  }
}

// ✅ KILL FOR ONE USER
async function removeUserJobs(userId) {
  const statuses = ["active", "waiting", "delayed"];

  for (const status of statuses) {
    let jobs;
    if (status === "active") {
      jobs = await taskQueue.getActive();
    } else if (status === "waiting") {
      jobs = await taskQueue.getWaiting();
    } else if (status === "delayed") {
      jobs = await taskQueue.getDelayed();
    }

    for (const job of jobs) {
      if (job.data.userId === userId) {
        try {
          if (status === "active") {
            console.log(`Killing active job ${job.id} for user ${userId}`);
            await job.moveToFailed({ message: "Killed by shutdown" }, true);
          } else {
            console.log(`Removing ${status} job ${job.id} for user ${userId}`);
            await job.remove();
          }
        } catch (err) {
          console.error(`Failed to process job ${job.id}:`, err);
        }
      }
    }
  }
}

// ✅ KILL FOR MULTIPLE USERS
async function killUsers(users) {
  for (const user of users) {
    console.log(`🔪 Killing jobs for user: ${user.userId}`);
    await removeUserJobs(user.userId);
  }
}

// ---- Uncomment one of the following below to use ----

// 🚨 Obliterate all tasks (use with extreme caution)
// killAll();

// ✅ Remove tasks for a single user
// removeUserJobs("user-123");

// ✅ Remove tasks for a list of users
// killUsers([{ userId: "user-123" }, { userId: "user-456" }]);

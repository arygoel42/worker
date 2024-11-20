const Bull = require("bull");
// const admin = require("./api/firebase.js");
require("dotenv").config();
const {
  fetchEmailHistory,
  getOrCreatePriorityLabel,
  applyLabelToEmail,
  fetchEmailHistoryWithRetry,
  fetchEmailHistoryAndApplyLabel,
} = require("./gmailService.js");

const taskQueue = new Bull("task-queue", {
  redis: {
    host: process.env.HOST,
    port: 18153,
    password: process.env.REDISPASS,
  },
});

console.log(
  "Worker initialized" + process.env.HOST,
  18153,
  process.env.REDISPASS
);

taskQueue.process(async (job) => {
  const { email, historyId, accessToken } = job.data;
  console.log("Worker running");

  try {
    const userMessages = await fetchEmailHistoryWithRetry(
      accessToken,
      historyId
    );

    if (userMessages.length === 0) {
      console.log("No new messages found after retries.");
      return; // Exit if no new messages
    }

    const priorityLabelId = await getOrCreatePriorityLabel(accessToken);
    for (const message of userMessages) {
      console.log("Applying label to message:", message.id);
      await applyLabelToEmail(accessToken, message.id, priorityLabelId);
    }

    console.log(`Processed task for email: ${email}, HistoryId: ${historyId}`);
  } catch (error) {
    console.error("Error processing job:", error);
    throw error;
  }
});

taskQueue.on("failed", (job, err) => {
  console.error(
    `Job failed for email: ${job.data.email}, historyId: ${job.data.historyId}. Error: ${err.message}`
  );
});

taskQueue.on("completed", (job) => {
  console.log(
    `Job completed for email: ${job.data.email}, historyId: ${job.data.historyId}`
  );
});

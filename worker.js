const Bull = require("bull");
// const admin = require("./api/firebase.js");
require("dotenv").config();
const {
  fetchEmailHistory,
  getOrCreatePriorityLabel,
  applyLabelToEmail,
  fetchEmailHistoryWithRetry,
  fetchEmailHistoryAndApplyLabel,
  getMessageDetails,
  archiveEmail,
  forwardEmail,
  favoriteEmail,
} = require("./gmailService.js");

const { classifyEmail, createDraftEmail } = require("./openai.js");

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
  const { email, historyId, accessToken, rules } = job.data;
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

    // const priorityLabelId = await getOrCreatePriorityLabel(accessToken);
    for (const message of userMessages) {
      console.log("Applying label to message:", message.id);
      const emailContent = await getMessageDetails(accessToken, message.id);
      console.log(emailContent);
      //getclassfy function

      const ruleKey = await classifyEmail(emailContent, rules);
      console.log("Rule key:", ruleKey);

      if (ruleKey === 'Null') {
        console.error("email not valid to rule");
        continue;
      }

      const rule = rules[parseInt(ruleKey)];
      console.log("Rule:", rule);

      for (const action of JSON.parse(rule.type)) {
        console.log("Action config:", action.config);
        console.log("Action:", action);

        if (action.type === "label") {
          console.log("Applying label:", action.config.labelName);
          const labelId = await getOrCreatePriorityLabel(accessToken, action.config.labelName);
          await applyLabelToEmail(accessToken, message.id, labelId);
        }
        else if (action.type === "archive") {
          console.log("Archiving email");
          await archiveEmail(accessToken, message.id);
        }
        else if (action.type === "forward") {
          console.log("Forwarding email");
          console.log("Forwarding to:", action.config.forwardTo);
          await forwardEmail(accessToken, message.id, action.config.forwardTo);
        }
        else if (action.type === "favorite") {
          console.log("favoriting email");
          await favoriteEmail(accessToken, message.id);
        } 
        else if (action.type === "draft") {
          console.log("drafting reply email") 
          await createDraftEmail(emailContent);
        }
      }

      // await applyLabelToEmail(accessToken, message.id, priorityLabelId);
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

taskQueue.on("completed", async (job) => {
  console.log(
    `Job completed for email: ${job.data.email}, historyId: ${job.data.historyId}`
  );
  await job.remove(); // Explicitly remove the job after completion
  return;
});




      
const Bull = require("bull");
const express = require("express");
const app = express();
const cors = require("cors");
const {
  saveEmailChunks,
  retrieveFullEmail,
  deleteEmails,
} = require("./RAGService.js");
const { fetchLast50Emails } = require("./gmailService.js");
require("dotenv").config();
const OpenAI = require("openai");
const path = require("path");
const dotenv = require("dotenv");

app.use(cors());
app.use(express.json());

const taskQueue = new Bull("task-queue", {
  redis: {
    host: process.env.HOST,
    port: 15237,
    password: process.env.REDISPASS,
  },
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

console.log("Worker initialized", process.env.HOST, process.env.REDISPASS);

// **Process jobs based on type**
taskQueue.process("onboarding", async (job) => {
  console.log("Processing onboarding task for new user...");

  const { accessToken, userId } = job.data;
  const progressKey = `progress:${userId}`; // Store user progress in Redis

  try {
    let emails = await fetchLast50Emails(accessToken);

    for (let i = 0; i < emails.length; i++) {
      let progress = Math.round(((i + 1) / emails.length) * 100); // Compute percentage
      await saveEmailChunks(userId, emails[i].messageId, emails[i].content);

      await job.progress(progress); // Bull's progress tracking
      await taskQueue.client.set(progressKey, progress); // Store progress in Redis
    }

    console.log("✅ RAG onboarding complete for user:", userId);
    await taskQueue.client.set(progressKey, 100); // Ensure it's marked as complete
  } catch (error) {
    console.error("❌ Error processing onboarding task:", error.message);
    await taskQueue.client.set(progressKey, -1); // Mark as failed (-1)
    throw error;
  }
});

taskQueue.process("embedding", async (job) => {
  console.log("Processing existing user task...");

  const { userId, emailId, emailContent } = job.data; // Existing user inputs
  try {
    saveEmailChunks(userId, emailId, emailContent);

    console.log("RAG embedding complete for user", userId);
  } catch (error) {}
});

taskQueue.process("disableRAG", async (job) => {
  const { userId } = job.data;

  deleteEmails(userId);

  console.log("deleting all emails from databse for user", userId);
});

// Handle failed jobs
taskQueue.on("failed", (job, err) => {
  console.error(`Job failed [${job.name}]:`, err.message);
});

// Remove completed jobs
taskQueue.on("completed", async (job) => {
  await job.remove();
});

app.get("/progress", async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ error: "Missing userId parameter" });
  }

  const progressKey = `progress:${userId}`;
  try {
    const progress = await taskQueue.client.get(progressKey); // Get progress from Redis
    res.json({ userId, progress: progress ? parseInt(progress) : 0 });
  } catch (error) {
    console.error("❌ Error fetching progress:", error);
    res.status(500).json({ error: "Unable to fetch progress" });
  }
});
app.post("/augmentedEmailSearch", async (req, res) => {
  const { userId, query } = req.body;

  if (!userId || !query) {
    return res.status(400).json({ error: "Missing userId or query" });
  }

  // Retrieve the full email based on the query
  const fullEmails = await retrieveFullEmail(userId, query);

  if (!fullEmails || fullEmails.length === 0) {
    return res.status(404).json({ error: "No relevant emails found." });
  }

  const currentDate = new Date().toISOString().split("T")[0]; // Get today's date in YYYY-MM-DD format

  const prompt = `
  You are an AI assistant that helps users retrieve relevant information from their emails. 
  Your responses should be **concise, relevant, and strictly based on the provided email context.** 

  **Date Understanding:**
  - **Today's date is: ${currentDate}**.  
  - If an email references a relative time (e.g., "tomorrow," "next week," or "yesterday"), interpret it based on the email's **sent date** rather than today's date.  
  - Convert relative date references into absolute dates when answering user questions.  

  **Relevant Emails Based on the Search Query:**  

  ${fullEmails
    .map((email) => `Date: ${email.date}\nContent: ${email.content}`)
    .join("\n\n")}

  **User's Query:** "${query}"  

  **Instructions:**  
  - Use the email dates to correctly interpret relative time references.  
  - If the answer is unclear, state that the emails do not contain enough information.  
  - Do **not** make up details that are not explicitly mentioned in the emails.  

  Based **only** on the given emails and the provided context, answer the question as accurately as possible.
`;

  console.log("Prompt:", prompt);

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are an assistant that provides the user with details regarding their emails.",
        },
        { role: "user", content: prompt },
      ],
    });
    console.log(
      "Semantic Search Completion:",
      completion.choices[0].message.content
    );
    res.status(200).json({ completion: completion.choices[0].message.content });
  } catch (error) {
    console.error("Error in semantic search:", error);
    res
      .status(500)
      .json({ error: "An error occurred while processing your request." });
  }
});

// Start Server
app.listen(3023, () => {
  console.log("Worker listening on port 3023");
});

//connect button and have it start and stop RAG, then work on querying via the frontend, then add progress bar.

//Not sure what happens if the user clicks enable and disable really fast so we may have to add a cooldown of at least 15 minutes.

const Bull = require("bull");
const express = require("express");
const app = express();
const cors = require("cors");
const {
  saveEmailChunks,
  retrieveFullEmail,
  deleteEmails,
  enforceMaxEmails,
} = require("./RAGService.js");
const { fetchLast50Emails } = require("./gmailService.js");
require("dotenv").config();
const OpenAI = require("openai");
const compression = require("compression");
const http = require("http");
const { Server } = require("socket.io");
const { setupSocket } = require("./socket.js");
const server = http.createServer(app); // Create the HTTP server
const io = new Server(server, {
  cors: { origin: "*" }, // Adjust for your frontend
});
app.use(compression());
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Flag to track shutdown state
let isShuttingDown = false;

// Create a Redis client connection pool
const taskQueue = new Bull("task-queue", {
  redis: {
    host: process.env.HOST,
    port: 15237,
    password: process.env.REDISPASS,
    maxRetriesPerRequest: 3,
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
    lockDuration: 600000, // 1 minute
    maxStalledCount: 3,
  },
});

// Create OpenAI client once
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

console.log("Worker initialized", process.env.HOST);

// Use a separate map to track active jobs
const activeJobs = new Map();

setupSocket(io);

// Helper function to update progress
const updateProgress = async (client, userId, progressData) => {
  // Skip updates during shutdown
  if (isShuttingDown) return;

  const progressKey = `progress:${userId}`;
  await client.set(progressKey, JSON.stringify(progressData));
};

setInterval(
  () => console.log(`Worker alive, Wait: ${taskQueue.getWaitingCount()}`),
  30000
);

// Add a check for shutdown state in all job processors
taskQueue.process("onboarding", 5, async (job, done) => {
  console.log(`Processing onboarding task for user ${job.data.userId}...`);
  const { accessToken, userId } = job.data;

  activeJobs.set(job.id, { type: "onboarding", userId });

  if (isShuttingDown) {
    activeJobs.delete(job.id);
    return done(new Error("Server is shutting down"));
  }

  try {
    await updateProgress(taskQueue.client, userId, {
      phase: "initializing",
      fetch: 0,
      save: 0,
      total: 0,
    });

    let emails = [];
    let lastProgressUpdate = Date.now();

    const emailFetchProgress = async (current, total) => {
      if (isShuttingDown) throw new Error("Server is shutting down");
      const now = Date.now();
      if (now - lastProgressUpdate < 500 && current < total) return;
      lastProgressUpdate = now;
      const progress = Math.round((current / total) * 50);
      await updateProgress(taskQueue.client, userId, {
        phase: "fetching",
        fetch: progress,
        save: 0,
        total: progress,
      });
    };

    emails = await fetchLast50Emails(accessToken, emailFetchProgress);

    const totalEmails = emails.length;
    const batchSize = 5;

    for (let i = 0; i < totalEmails; i += batchSize) {
      if (isShuttingDown) throw new Error("Server is shutting down");
      const batch = emails.slice(i, Math.min(i + batchSize, totalEmails));
      await Promise.all(
        batch.map((email) =>
          saveEmailChunks(userId, email.messageId, email.content)
        )
      );

      const saveProgress = Math.round(
        (Math.min(i + batchSize, totalEmails) / totalEmails) * 50
      );
      await updateProgress(taskQueue.client, userId, {
        phase: "saving",
        fetch: 50,
        save: saveProgress,
        total: 50 + saveProgress,
      });
    }

    await updateProgress(taskQueue.client, userId, {
      phase: "complete",
      fetch: 50,
      save: 50,
      total: 100,
    });

    activeJobs.delete(job.id);
    done(null, { status: "success", userId });
  } catch (error) {
    if (!isShuttingDown) {
      try {
        await deleteEmails(userId);
      } catch (error) {
        console.error(
          `Failed to delete emails for user ${userId}:`,
          deleteError
        );
      }
      await updateProgress(taskQueue.client, userId, {
        phase: "error",
        fetch: 0,
        save: 0,
        total: -1,
      });
    }
    activeJobs.delete(job.id);
    done(error);
  }
});

taskQueue.process("embedding", async (job, done) => {
  console.log(`Processing embedding task for user ${job.data.userId}...`);
  const { userId, emailId, emailContent } = job.data;
  console.log("emailContent", emailContent);

  // Track this job as active
  activeJobs.set(job.id, { type: "embedding", userId });

  // Check if we're shutting down
  if (isShuttingDown) {
    activeJobs.delete(job.id);
    return done(new Error("Server is shutting down"));
  }

  try {
    await enforceMaxEmails(userId);
    console.log("EMAIL CONTENT : ", emailContent);
    await saveEmailChunks(userId, emailId, emailContent);
    console.log("RAG embedding complete for user", userId);
    activeJobs.delete(job.id);
    done(null, { status: "success", userId }); // Fix Bull callback
  } catch (error) {
    console.error(`Embedding error for user ${userId}:`, error);
    activeJobs.delete(job.id);
    done(error);
  }
});

taskQueue.process("disableRAG", 5, async (job, done) => {
  console.log(`Processing disableRAG task for user ${job.data.userId}...`);
  const { userId } = job.data;

  activeJobs.set(job.id, { type: "disableRAG", userId });

  if (isShuttingDown) {
    activeJobs.delete(job.id);
    return done(new Error("Server is shutting down"));
  }

  try {
    await updateProgress(taskQueue.client, userId, {
      phase: "deleting",
      fetch: 0,
      save: 0,
      total: 0,
    });

    let lastProgressUpdate = Date.now();
    await deleteEmails(userId, async (current, total) => {
      if (isShuttingDown) throw new Error("Server is shutting down");
      const now = Date.now();
      if (now - lastProgressUpdate < 500 && current < total) return;
      lastProgressUpdate = now;
      const progress = Math.round((current / total) * 100);
      await updateProgress(taskQueue.client, userId, {
        phase: "deleting",
        fetch: 0,
        save: 0,
        total: progress,
      });
    });

    await updateProgress(taskQueue.client, userId, {
      phase: "complete",
      fetch: 0,
      save: 0,
      total: 100,
    });

    console.log("Deleted all emails from database for user", userId);
    activeJobs.delete(job.id);
    done(null, { status: "success", userId });
  } catch (error) {
    if (!isShuttingDown) {
      await updateProgress(taskQueue.client, userId, {
        phase: "error",
        fetch: 0,
        save: 0,
        total: -1,
      });
    }
    activeJobs.delete(job.id);
    done(error);
  }
});
// Handle failed jobs
taskQueue.on("failed", (job, err) => {
  console.error(
    `Job failed [${job.name}] for user ${job.data.userId}:`,
    err.message
  );
  activeJobs.delete(job.id);
});

// Properly remove completed jobs
taskQueue.on("completed", async (job) => {
  console.log(`Job completed [${job.name}] for user ${job.data.userId}`);
  activeJobs.delete(job.id);
  await job.remove();
});

// Implement API endpoints with response caching
const cache = new Map();
const CACHE_TTL = 5000; // 5 seconds TTL

app.get("/progress", async (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ error: "Server is shutting down" });
  }

  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ error: "Missing userId parameter" });
  }

  const progressKey = `progress:${userId}`;
  const cacheKey = `progress:${userId}`;
  const cachedResponse = cache.get(cacheKey);

  // Return cached response if available and fresh
  if (cachedResponse && Date.now() - cachedResponse.timestamp < CACHE_TTL) {
    return res.json(cachedResponse.data);
  }

  try {
    const progressData = await taskQueue.client.get(progressKey);
    const defaultProgress = {
      phase: "waiting",
      fetch: 0,
      save: 0,
      total: 0,
    };

    let response;
    if (progressData) {
      response = JSON.parse(progressData);
      // If the task is completed, reset it to "waiting" for the next query
      if (response.phase === "completed") {
        response = defaultProgress;
        await taskQueue.client.set(progressKey, JSON.stringify(response)); // Reset in task queue
        cache.del(cacheKey); // Clear the cache
      }
    } else {
      response = defaultProgress; // No progress data means no active task
    }

    // Cache the response
    cache.set(cacheKey, {
      timestamp: Date.now(),
      data: response,
    });

    res.json(response);
  } catch (error) {
    console.error(`Error fetching progress for user ${userId}:`, error);
    res.status(500).json({ phase: "error", fetch: 0, save: 0, total: 0 });
  }
});

app.get("/", (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ message: "Server is shutting down" });
  }
  res.send("Worker is running");
});

// Optimize email search with caching
const searchCache = new Map();
const SEARCH_CACHE_TTL = 60000; // 1 minute TTL for search results

app.post("/augmentedEmailSearch", async (req, res) => {
  // Don't process new requests during shutdown
  if (isShuttingDown) {
    return res.status(503).json({ error: "Server is shutting down" });
  }

  const { userId, query } = req.body;

  if (!userId || !query) {
    return res.status(400).json({ error: "Missing userId or query" });
  }

  const cacheKey = `search:${userId}:${query}`;
  const cachedResult = searchCache.get(cacheKey);

  // Return cached response if available and fresh
  if (cachedResult && Date.now() - cachedResult.timestamp < SEARCH_CACHE_TTL) {
    return res.json(cachedResult.data);
  }

  try {
    //open api call
    // for loop append response to a array
    //then send as context to us the one that returns the most amount of email ids.
    // Retrieve the full email based on the query
    const rewrite_prompt = `The following is the user's query: "${query}". 

    Your task is to rewrite the query to ensure it works optimally with my RAG (Retrieval-Augmented Generation) system. The RAG system uses a retrieval process to find the most relevant emails from the user's inbox, and then a generation model is applied to answer the user's query based on those emails.
    
    Please rewrite the query so that it is clear, concise, and properly structured for the RAG system to retrieve the most relevant emails and generate the best response. Keep the same tone and style as the original query, but ensure it works effectively with the system's capabilities.
    
    Only return the rewritten query, and ensure it is optimized for retrieving and generating information accurately from the user's emails.`;

    const rewrite_response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: rewrite_prompt }],
    });

    // Extract the rewritten query
    const rewritten_query = rewrite_response.choices[0].message.content.trim();

    console.log("Rewritten Query:", rewritten_query);

    const fullEmails = await retrieveFullEmail(userId, rewritten_query);

    if (!fullEmails || fullEmails.length === 0) {
      const noResult = { response: "No relevant emails found", emailIds: [] };
      searchCache.set(cacheKey, { timestamp: Date.now(), data: noResult });
      return res.status(200).json(noResult);
    }

    const currentDate = new Date().toISOString().split("T")[0];

    const prompt = `
You’re a friendly AI assistant here to help users dig up info from their emails with ease! I’ll keep my responses **sweet, and spot-on**, sticking strictly to the email context you provide—no making things up or pulling from outside sources.

**Date Smarts:**
- Today’s date is: ${currentDate} (format: YYYY-MM-DD).
- For time references like "tomorrow," "next week," or "yesterday," I’ll use the **sent date** of the email as my guide, not today’s date. I’ll turn those into exact dates (YYYY-MM-DD) for clarity.
- For example: If an email from 2025-03-01 mentions "meeting tomorrow," I’ll read that as 2025-03-02.

**Here’s What I’m Working With:**
${fullEmails
  .map(
    (email, index) =>
      `### Email ${index + 1}\n**ID:** ${email.emailId}\n**Content:** ${
        email.content
      }`
  )
  .join("\n\n")}

**Your Question:** "${rewritten_query}"

**How I’ll Help:**
- I’ll base my answer **only** on the emails you’ve shared. If your question pulls from multiple emails, I’ll zero in on the most relevant ones and give you a quick heads-up on why I chose them.
- For vague stuff (like "meeting next week"), I’ll lean on the latest relevant email unless you tell me otherwise—and I’ll let you know my pick!
- If I can’t find a clear answer, I’ll say: "**Hmm, No Luck Here:** Looks like these emails don’t have quite enough to work with for this one."
- No guessing or outside info here—just what’s in the emails, delivered with a smile!
- I’ll toss in the IDs of the emails I used in the emailIds array.

**How I’ll Respond:**
Here’s the JSON format I’ll use:
{
  "response": "A friendly, markdown-formatted answer! I’ll use headers (##), lists (- or *),starts with a **bold** flourish or some *italic* flair to keep things clear and engaging—short, helpful, and never dull.",
  "emailIds": ["list", "of", "email", "IDs", "I", "leaned", "on"]
}
`;

    console.log("Prompt:", prompt);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content:
            "You are an assistant that provides the user with details regarding their emails.",
        },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" }, // Ensure structured JSON output
    });

    // Parse the JSON response from OpenAI
    const result = completion.choices[0].message.content;
    jsonResult = JSON.parse(result);

    console.log("Result:", jsonResult);

    // Cache the structured result
    searchCache.set(cacheKey, {
      timestamp: Date.now(),
      data: result,
    });

    // Return the structured response
    res.status(200).json({ completion: jsonResult });
  } catch (error) {
    console.error("Error in semantic search:", error);
    res
      .status(500)
      .json({ error: "An error occurred while processing your request." });
  }
});
// Endpoint to cancel active jobs for a user
app.post("/cancelJobs", async (req, res) => {
  // Don't process new requests during shutdown
  if (isShuttingDown) {
    return res.status(503).json({ error: "Server is shutting down" });
  }

  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: "Missing userId" });
  }

  try {
    let canceledCount = 0;

    // Find all active jobs for this user
    for (const [jobId, jobInfo] of activeJobs.entries()) {
      if (jobInfo.userId === userId) {
        const job = await taskQueue.getJob(jobId);
        if (job) {
          await job.discard();
          await job.moveToFailed(
            new Error("Job canceled by user request"),
            true
          );
          canceledCount++;
        }
      }
    }

    // Update progress to canceled
    await updateProgress(taskQueue.client, userId, {
      phase: "canceled",
      fetch: 0,
      save: 0,
      total: 0,
    });

    res.json({
      success: true,
      message: `Canceled ${canceledCount} jobs for user ${userId}`,
    });
  } catch (error) {
    console.error(`Error canceling jobs for user ${userId}:`, error);
    res.status(500).json({ error: "Failed to cancel jobs" });
  }
});

// Periodic cleanup of old cache entries
const cacheCleanupInterval = setInterval(() => {
  const now = Date.now();

  // Skip during shutdown
  if (isShuttingDown) return;

  // Clean up progress cache
  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      cache.delete(key);
    }
  }

  // Clean up search cache
  for (const [key, value] of searchCache.entries()) {
    if (now - value.timestamp > SEARCH_CACHE_TTL) {
      searchCache.delete(key);
    }
  }
}, 60000); // Run cleanup every minute

// Reference to the HTTP server

// Improved shutdown function - fast and forceful
const shutdown = async () => {
  // Prevent multiple shutdown calls
  if (isShuttingDown) {
    console.log("Shutdown already in progress");
    return;
  }

  const startTime = Date.now();
  console.log("Initiating FORCEFUL shutdown...");
  isShuttingDown = true;

  // Set a hard timeout in case something hangs
  const forceExitTimeout = setTimeout(() => {
    console.error("Shutdown timed out after 10 seconds, forcing exit");
    process.exit(1);
  }, 10000);

  try {
    // 1. Stop HTTP server immediately
    console.log("Stopping HTTP server...");
    server.close();

    // 2. Pause the queue to prevent new job processing
    console.log("Pausing queue...");
    await taskQueue.pause(true);

    // 3. Obliterate the queue (removes all jobs including active ones)
    console.log("Obliterating queue...");
    await taskQueue.obliterate({ force: true });

    // 4. Clean up progress data from Redis
    console.log("Cleaning progress data...");
    const progressKeys = await taskQueue.client.keys("progress:*");
    if (progressKeys.length > 0) {
      await taskQueue.client.del(...progressKeys);
    }

    // 5. Clean up cache data
    cache.clear();
    searchCache.clear();

    // 6. Close Bull queue and Redis connections
    console.log("Closing queue and connections...");
    await taskQueue.close(true);

    // 7. Try to forcefully disconnect Redis
    if (taskQueue.client && taskQueue.client.disconnect) {
      await taskQueue.client.disconnect();
    }

    clearTimeout(forceExitTimeout);
    const shutdownTime = (Date.now() - startTime) / 1000;
    console.log(`Forceful shutdown completed in ${shutdownTime}s`);

    // Exit process with success code
    process.exit(0);
  } catch (error) {
    console.error("Error during forceful shutdown:", error);
    clearTimeout(forceExitTimeout);
    process.exit(1);
  }
};

taskQueue.on("stalled", async (job) => {
  console.log(`Job ${job.id} stalled, rescheduling in 10s`);
  await myQueue.add(job.data, { delay: 10000 }); // Retry with delay
});

taskQueue.client.on("error", (err) => console.log(`Redis error: ${err}`));

app.post("/toggleRAG", async (req, res) => {
  if (isShuttingDown)
    return res.status(503).json({ error: "Server is shutting down" });
  const { userId, enable, accessToken } = req.body;
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  try {
    if (enable) {
      // Trigger onboarding when enabling RAG
      await taskQueue.add(
        "onboarding",
        { accessToken, userId },
        { jobId: `onboarding-${userId}` }
      );
      res.json({ success: true, message: "RAG enabled, onboarding started" });
    } else {
      // Trigger disableRAG when disabling
      await taskQueue.add(
        "disableRAG",
        { userId },
        { jobId: `disableRAG-${userId}` }
      );
      res.json({ success: true, message: "RAG disabled, cleanup started" });
    }
  } catch (error) {
    console.error(`Error toggling RAG for user ${userId}:`, error);
    res.status(500).json({ error: "Failed to toggle RAG" });
  }
});

// Create HTTP server
server.listen(3023, () => {
  console.log("Worker listening on port 3023");
});

// Add timeout to server responses to prevent hanging connections

// Handle process termination signals
process.on("SIGINT", shutdown); // Ctrl + C
process.on("SIGTERM", shutdown); // Docker stop / Heroku shutdown
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  shutdown();
});

// Obliterate the queue on startup to kill any existing tasks
taskQueue
  .obliterate({ force: true })
  .then(() => {
    console.log("All existing tasks have beenkilled on startup.");
  })
  .catch((err) => {
    console.error("Error obliterating queue on startup:", err);
  });

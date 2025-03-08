const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { Pinecone } = require("@pinecone-database/pinecone");
const pLimit = require("p-limit").default;
require("dotenv").config();
const { upsertRateLimiter } = require("./RateLimiter");
const natural = require("natural");
const { removeStopwords } = require("stopword");

const app = express();

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const pc = new Pinecone({
  apiKey: process.env.PINECONE_APIKEY,
});

const indexName = "quickstart";

const index = pc.index(indexName);
const limit = pLimit(5);

function chunkEmail(emailText, chunkSize = 512, overlap = 50) {
  // Validate input
  if (!emailText || typeof emailText !== "string") {
    console.error("Error: emailText is undefined or not a string.");
    return [];
  }

  // Preprocess to remove fluff
  emailText = removeFluff(emailText);

  // Initialize tokenizer and variables
  const sentenceTokenizer = new natural.SentenceTokenizer();
  let paragraphs = emailText.split(/\n\s*\n/); // Split by double newlines
  let chunks = [];
  let currentChunk = [];
  let currentLength = 0;

  // Process each paragraph
  for (let paragraph of paragraphs) {
    let sentences = sentenceTokenizer.tokenize(paragraph);
    let paragraphLength = paragraph.split(" ").length;

    if (paragraphLength <= chunkSize) {
      // If paragraph fits and isn’t fluff, store it
      let filteredParagraph = filterSentences(paragraph);
      if (filteredParagraph) chunks.push(filteredParagraph);
      continue;
    }

    // Split large paragraphs into sentence-based chunks
    for (let sentence of sentences) {
      let filteredSentence = filterSentences(sentence);
      if (!filteredSentence) continue; // Skip irrelevant sentences

      let sentenceLength = filteredSentence.split(" ").length;

      if (currentLength + sentenceLength > chunkSize) {
        if (currentChunk.length > 0) {
          chunks.push(currentChunk.join(" "));
          // Overlap: keep the last few sentences
          currentChunk = currentChunk.slice(-Math.ceil(overlap / 10));
          currentLength = currentChunk.reduce(
            (sum, s) => sum + s.split(" ").length,
            0
          );
        }
      }

      currentChunk.push(filteredSentence);
      currentLength += sentenceLength;
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk.join(" "));
      currentChunk = [];
      currentLength = 0;
    }
  }

  console.log("Chunks count:", chunks.length);
  return chunks;
}

// Remove greetings, farewells, signatures, etc.
function removeFluff(emailText) {
  // Remove greetings
  emailText = emailText.replace(
    /^[\s]*(Hi|Hello|Dear|Good morning|Good afternoon)[^\n]*,\n?/i,
    ""
  );

  // Remove farewells
  // emailText = emailText.replace(
  //   /\n(Best regards|Sincerely|Thanks|Thank you|Cheers|Warm regards)[^\n]*$/i,
  //   ""
  // );

  // Remove signatures (heuristic: last 5 lines)
  const lines = emailText.split("\n");
  if (lines.length > 5) {
    emailText = lines.slice(0, -5).join("\n");
  }

  // Remove quoted replies
  emailText = emailText.replace(/^\s*>.*$/gm, "");

  // Remove boilerplate
  emailText = emailText.replace(/This email is confidential.*$/i, "");

  return emailText.trim();
}

// Filter out short or fluff sentences
function filterSentences(sentence) {
  const minLength = 5; // Minimum word count
  if (sentence.split(" ").length < minLength) return null;

  // Skip common fluff phrases
  const fluffPhrases = [
    "please let me know",
    "feel free to reach out",
    "looking forward to hearing from you",
  ];
  if (fluffPhrases.some((phrase) => sentence.toLowerCase().includes(phrase)))
    return null;

  // Remove stopwords for cleaner content
  return removeStopwords(sentence.split(" ")).join(" ");
}

const getEmbedding = async (text) => {
  try {
    const response = await axios.post(
      "https://api.openai.com/v1/embeddings",
      {
        input: text,
        model: "text-embedding-ada-002",
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data.data[0].embedding;
  } catch (error) {
    console.error("OpenAI API Error:", error.response?.data || error.message);
    throw error;
  }
};

const getRateLimitedEmbedding = (text) => {
  return limit(() => getEmbedding(text)); // Enqueue request to be rate-limited
};

let lastCall = 0;
const DELAY_MS = 100; // 100ms delay (10 calls/second)

// Shared variable to track the last query time
let lastQueryTime = 0;
const MIN_DELAY = 1000; // 1 second in milliseconds

// Helper function to enforce a 1-second delay before querying Pinecone
async function delayedQuery(queryParams) {
  const now = Date.now();
  const timeSinceLast = now - lastQueryTime;
  if (timeSinceLast < MIN_DELAY) {
    // Wait for the remaining time to ensure a 1-second gap
    await new Promise((resolve) =>
      setTimeout(resolve, MIN_DELAY - timeSinceLast)
    );
  }
  lastQueryTime = Date.now(); // Update the last query time
  return await index.query(queryParams); // Execute the query
}

// Modified enforceMaxEmails function
async function enforceMaxEmails(userId) {
  try {
    // Query Pinecone with a 1-second delay enforced
    const existingEmails = await delayedQuery({
      vector: new Array(1536).fill(0),
      topK: 10000,
      includeMetadata: true,
      filter: { user_id: { $eq: userId } },
    });

    // Process the query results
    const emailMap = new Map();
    existingEmails.matches.forEach((match) => {
      const emailId = match.metadata.email_id;
      if (!emailMap.has(emailId)) {
        emailMap.set(emailId, {
          timestamp: match.metadata.timestamp,
          count: 1,
        });
      }
    });

    // If the number of unique emails is less than 500, no action needed
    if (emailMap.size < 500) return;

    // Find the oldest email to delete
    const oldestEntry = [...emailMap.entries()].reduce((oldest, current) => {
      return current[1].timestamp < oldest[1].timestamp ? current : oldest;
    });

    console.log(`Deleting oldest email ${oldestEntry[0]} for user ${userId}`);

    // Delete the oldest email's vectors from Pinecone
    await index.deleteMany({
      filter: {
        $and: [
          { user_id: { $eq: userId } },
          { email_id: { $eq: oldestEntry[0] } },
        ],
      },
    });
  } catch (error) {
    console.error("Error enforcing email limits:", error);
    throw error;
  }
}
// Modified saveEmailChunks function
async function saveEmailChunks(userId, emailId, emailText) {
  const MAX_RETRIES = 3;
  let retryCount = 0;

  // Helper function for delay
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  while (retryCount < MAX_RETRIES) {
    try {
      console.log("Saving email chunks...");

      // Enforce any user-specific limits (if applicable)
      await enforceMaxEmails(userId);

      // Split the email into chunks
      const chunks = chunkEmail(emailText, 512, 100);
      const vectors = [];
      const timestamp = Date.now();

      // Generate embeddings for each chunk
      for (let i = 0; i < chunks.length; i++) {
        const embedding = await getRateLimitedEmbedding(chunks[i]);
        vectors.push({
          id: `${userId}_${emailId}_chunk${i}`,
          values: embedding,
          metadata: {
            user_id: userId.toString(),
            email_id: emailId.toString(),
            chunk_id: i,
            content: chunks[i],
            timestamp: timestamp,
          },
        });
      }

      if (vectors.length === 0) {
        console.error("No valid vectors to upsert");
        return;
      }

      // Upsert vectors one at a time with a 1-second delay between each
      for (let i = 0; i < vectors.length; i++) {
        console.log(`Upserting vector ${i + 1} of ${vectors.length}`);
        await index.upsert([vectors[i]]); // Upsert a single vector

        // Wait 1 second before the next vector (skip delay on the last one)
        if (i < vectors.length - 1) {
          await delay(2000); // 1-second delay between vectors
        }
      }

      console.log(
        `Successfully saved ${vectors.length} vectors for email ${emailId}`
      );
      return;
    } catch (error) {
      if (
        error.name === "PineconeConnectionError" &&
        retryCount < MAX_RETRIES - 1
      ) {
        const backoffTime = Math.pow(2, retryCount) * 1000; // Exponential backoff
        console.warn(`Connection error, retrying in ${backoffTime}ms...`);
        await delay(backoffTime);
        retryCount++;
      } else {
        console.error("Error saving email chunks:", error);
        throw error;
      }
    }
  }
  throw new Error("Max retries reached for upsert");
}

async function retrieveFullEmail(
  userId,
  query,
  similarityThreshold = 0.8,
  maxEmails = 30
) {
  // Step 1: Convert query into embedding
  const queryEmbedding = await getRateLimitedEmbedding(query);

  // Step 2: Retrieve a large number of potential matches
  const results = await index.query({
    vector: queryEmbedding,
    topK: 1000, // High value to retrieve as many matches as possible
    includeMetadata: true,
    filter: { user_id: userId }, // Only get emails for this user
  });

  // Step 3: Filter out emails below the similarity threshold
  let emailIdRelevanceMap = new Map();
  results.matches.forEach((match) => {
    if (match.score >= similarityThreshold) {
      const emailId = match.metadata.email_id;
      if (!emailIdRelevanceMap.has(emailId)) {
        emailIdRelevanceMap.set(emailId, match.score);
      }
    }
  });

  console.log("Email IDs (above threshold):", [...emailIdRelevanceMap.keys()]);

  // Step 4: Sort email IDs by highest relevance score & enforce the 30-email limit
  const sortedEmails = [...emailIdRelevanceMap.entries()]
    .sort((a, b) => b[1] - a[1]) // Sort by score (descending)
    .slice(0, maxEmails); // Keep only the top 30

  let fullEmails = [];

  // Step 5: Retrieve chunks for each email, up to the 30-email limit
  for (const [emailId, score] of sortedEmails) {
    const emailChunks = await index.query({
      vector: Array(1536).fill(0), // Dummy vector to retrieve all chunks
      topK: 100,
      includeMetadata: true,
      filter: { user_id: userId, email_id: emailId },
    });

    // Sort chunks by chunk_id
    const sortedChunks = emailChunks.matches.sort(
      (a, b) => a.metadata.chunk_id - b.metadata.chunk_id
    );

    if (sortedChunks.length === 0) {
      console.error("No chunks found for email:", emailId);
      continue;
    }

    // Reconstruct full email
    const fullEmail = sortedChunks
      .map((chunk) => chunk.metadata.content)
      .join("\n");

    fullEmails.push({ emailId, score, content: fullEmail });

    // Stop early if we hit the limit (redundant but safe)
    if (fullEmails.length >= maxEmails) break;
  }

  return fullEmails;
}

async function deleteEmails(userId) {
  try {
    console.log(`Deleting all emails for user ${userId}...`);
    let emailIds = new Set();

    // Step 1: Find all email IDs belonging to the user
    const queryResults = await index.query({
      vector: Array(1536).fill(0),
      filter: { user_id: userId },
      topK: 10000,
      includeMetadata: true,
    });

    // Extract unique email IDs
    queryResults.matches.forEach((match) => {
      if (match.metadata?.email_id) {
        emailIds.add(match.metadata.email_id);
      }
    });

    if (emailIds.size === 0) {
      console.log(`No emails found for user ${userId}.`);
      return;
    }

    // Step 2: Find and delete chunks related to these email IDs
    for (const emailId of emailIds) {
      console.log(`Querying Pinecone for email_id: ${emailId}`);

      const chunkResults = await index.query({
        vector: Array(1536).fill(0),
        filter: { email_id: { $eq: emailId } }, // Ensure correct filter format
        topK: 10000,
      });

      console.log("Query results:", JSON.stringify(chunkResults, null, 2));

      const chunkIdsToDelete = chunkResults.matches.map((match) => match.id);
      console.log("Chunk IDs to delete:", chunkIdsToDelete);

      if (!chunkIdsToDelete || chunkIdsToDelete.length === 0) {
        console.log(
          `No chunk IDs found for deletion. Skipping delete for email_id: ${emailId}`
        );
        continue;
      }

      // ✅ Use deleteMany() instead of delete()
      await index.deleteMany(chunkIdsToDelete);
      console.log(
        `Deleted ${chunkIdsToDelete.length} chunks for email_id: ${emailId}`
      );
      delay(200);
    }
  } catch (error) {
    console.error("Error deleting emails:", error);
  }
}

module.exports = {
  saveEmailChunks,
  retrieveFullEmail,
  deleteEmails,
};

//make sure you import all packages
//export the functions

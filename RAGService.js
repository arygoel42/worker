const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { Pinecone } = require("@pinecone-database/pinecone");
const natural = require("natural");
const pLimit = require("p-limit").default;
require("dotenv").config();

const app = express();

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const pc = new Pinecone({
  apiKey: process.env.PINECONE_APIKEY,
});

const indexName = "quickstart";

const index = pc.index(indexName);
const limit = pLimit(5);

function chunkEmail(emailText, chunkSize = 512, overlap = 100) {
  if (!emailText || typeof emailText !== "string") {
    console.error("Error: emailText is undefined or not a string.");
    return [];
  }
  const sentenceTokenizer = new natural.SentenceTokenizer();

  let paragraphs = emailText.split(/\n\s*\n/); // Split by paragraph (double newlines)
  let chunks = [];
  let currentChunk = [];
  let currentLength = 0;

  for (let paragraph of paragraphs) {
    let sentences = sentenceTokenizer.tokenize(paragraph);
    let paragraphLength = paragraph.split(" ").length;

    if (paragraphLength <= chunkSize) {
      // If paragraph fits, store it as a chunk
      chunks.push(paragraph);
      continue;
    }

    // If paragraph is too long, split it into sentence-based chunks
    for (let sentence of sentences) {
      let sentenceLength = sentence.split(" ").length;

      if (currentLength + sentenceLength > chunkSize) {
        chunks.push(currentChunk.join(" ")); // Store chunk
        currentChunk = currentChunk.slice(-(overlap / 10)); // Keep overlap
        currentLength = currentChunk.reduce(
          (sum, s) => sum + s.split(" ").length,
          0
        );
      }

      currentChunk.push(sentence);
      currentLength += sentenceLength;
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk.join(" ")); // Add final chunk
      currentChunk = [];
      currentLength = 0;
    }
  }
  console.log("Chunks count:", chunks.length);

  return chunks;
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

async function enforceMaxEmails(userId) {
  try {
    // First check how many unique emails the user has
    const existingEmails = await index.query({
      vector: new Array(1536).fill(0), // Dummy vector
      topK: 10000,
      includeMetadata: true,
      filter: { user_id: { $eq: userId } },
    });

    // Create a map of email IDs with their oldest timestamp
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

    // If under limit, do nothing
    if (emailMap.size < 500) return;

    // Find the oldest email ID
    const oldestEntry = [...emailMap.entries()].reduce((oldest, current) => {
      return current[1].timestamp < oldest[1].timestamp ? current : oldest;
    });

    console.log(`Deleting oldest email ${oldestEntry[0]} for user ${userId}`);

    // Delete all chunks for the oldest email
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
  try {
    console.log("Saving email chunks...");

    // First enforce email limits
    await enforceMaxEmails(userId); // Now properly awaited

    const chunks = chunkEmail(emailText, 512, 100);
    const vectors = [];
    const timestamp = Date.now(); // Add timestamp to metadata

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
          timestamp: timestamp, // Add timestamp to metadata
        },
      });
    }

    if (vectors.length === 0) {
      console.error("No valid vectors to upsert");
      return;
    }

    // Batch upsert with rate limiting
    const BATCH_SIZE = 100;
    for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
      const batch = vectors.slice(i, i + BATCH_SIZE);
      await index.upsert(batch);
      await delay(200); // Proper rate limiting
    }

    console.log(
      `Successfully saved ${vectors.length} chunks for email ${emailId}
          ++++++++++++++++++++++++++++++++++++++++++++++++++++++++`
    );
  } catch (error) {
    console.error("Error saving email chunks:", error);
    throw error;
  }
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

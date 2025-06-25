const { config } = require("dotenv").config();
const { retrieveFullEmail } = require("./RAGService");
const { OpenAI } = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const { relabel, singleDraft, massOutreachDraft } = require("./gmailService");

// ====== CONVERSATION STORAGE ======
// In-memory storage for conversations per socket connection
const conversations = new Map(); // socketId -> conversation history

// Add message to conversation history
function addToConversation(socketId, message, sender = "user") {
  if (!conversations.has(socketId)) {
    conversations.set(socketId, []);
  }

  const conversation = conversations.get(socketId);
  conversation.push({
    message: message,
    sender: sender, // 'user' or 'assistant'
    timestamp: new Date().toISOString(),
  });

  // Keep only last 20 messages to prevent memory overflow
  if (conversation.length > 20) {
    conversation.splice(0, conversation.length - 20);
  }
}

// Get conversation history for a socket
function getConversationHistory(socketId) {
  return conversations.get(socketId) || [];
}

// Clear conversation history for a socket
function clearConversation(socketId) {
  conversations.delete(socketId);
}

// Debug function to get conversation stats
function getConversationStats() {
  const stats = {
    totalConversations: conversations.size,
    conversationLengths: [],
  };

  conversations.forEach((conversation, socketId) => {
    stats.conversationLengths.push({
      socketId: socketId,
      messageCount: conversation.length,
    });
  });

  return stats;
}

// ====== CONTEXT-AWARE QUERY ENHANCEMENT ======
async function enhanceQueryWithContext(clientQuery, socketId) {
  const conversationHistory = getConversationHistory(socketId);

  // If no conversation history, return original query
  if (conversationHistory.length === 0) {
    return {
      enhancedQuery: clientQuery,
      contextUsed: false,
      reasoning: "No conversation history available",
    };
  }

  // Build context from recent conversation
  const recentContext = conversationHistory
    .slice(-10) // Last 10 messages
    .map((entry) => `${entry.sender}: ${entry.message}`)
    .join("\n");

  const contextPrompt = `You are helping enhance a user query by adding conversation context. The user has an ongoing conversation and their latest query might reference previous messages.

**Conversation History (most recent):**
${recentContext}

**Latest User Query:** "${clientQuery}"

**Your Task:**
Analyze if the latest query references previous conversation context (like "that email", "he said", "the one we discussed", "reply to it", etc.). If it does, enhance the query by adding the missing context to make it self-contained and clear.

if the user is asking a query that is not related to the conversation history, return the original query.

**Response Format (JSON):**
{
  "enhancedQuery": "The improved query with context added",
  "contextUsed": true/false,
  "reasoning": "Brief explanation of what context was added or why none was needed"
}

**Examples:**
- If user previously asked about "emails from John" and now says "reply to it" → enhance to "reply to the email from John"
- if the User previosly asked about a specific email and now says "label, or draft a response to it" → enhance to "label the email as 'important' or draft a response to the email from john + more email context"
- If user says "find emails about the meeting" with no prior context → keep original
- If user says "that project email" after discussing project emails → enhance with specific project context

Only enhance if there are clear references that need context. Don't change queries that are already complete.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: contextPrompt }],
      response_format: { type: "json_object" },
    });

    const result = JSON.parse(response.choices[0].message.content);
    console.log(
      `[CONTEXT] Query enhancement - Used context: ${result.contextUsed}, Reasoning: ${result.reasoning}`
    );

    return result;
  } catch (error) {
    console.error("Error enhancing query with context:", error);
    return {
      enhancedQuery: clientQuery,
      contextUsed: false,
      reasoning: "Error in context enhancement",
    };
  }
}

const tools = [
  //   {
  //     type: "function",
  //     function: {
  //       name: "archiveEmails",
  //       description: "Archive a specific email",
  //       parameters: {
  //         type: "object",
  //         properties: {
  //           accessToken: { type: "string", description: "User's access token" },
  //           emailId: {
  //             type: "string",
  //             description: "ID of the email to archive",
  //           },
  //         },
  //         required: ["accessToken", "emailId"],
  //       },
  //     },
  //   },
  {
    type: "function",
    function: {
      name: "label",
      description:
        "Add a label to a specific email. Use this when the user explicitly asks to label or organize an email.",
      parameters: {
        type: "object",
        properties: {
          labelName: { type: "string", description: "Label to apply" },
        },
        required: ["labelName"],
      },
    },
  },
  //   {
  //     type: "function",
  //     function: {
  //       name: "forwardEmails",
  //       description: "Forward a specific email to a recipient",
  //       parameters: {
  //         type: "object",
  //         properties: {
  //           accessToken: { type: "string", description: "User's access token" },
  //           emailId: {
  //             type: "string",
  //             description: "ID of the email to forward",
  //           },
  //           recipient: {
  //             type: "string",
  //             description: "Recipient's email or name",
  //           },
  //           context: {
  //             type: "string",
  //             description: "Forwarding message (optional)",
  //           },
  //         },
  //         required: ["accessToken", "emailId", "recipient"],
  //       },
  //     },
  //   },
  {
    type: "function",
    function: {
      name: "draftResponse",
      description:
        "Create a draft in response to a specific email. Use this when the user wants to respond to an email or person with a message draft.",
      parameters: {
        type: "object",
        properties: {
          extraContext: {
            type: "string",
            description: "Instructions to follow for the draft",
          },
        },
        required: ["extraContext"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "createNewDrafts",
      description:
        "Create new outbound drafts for emails. Use this when the user wants to create a new draft or new drafts to multiple recipients.",
      parameters: {
        type: "object",
        properties: {
          extraContext: { type: "string", description: "extra Draft content" },
          emails: {
            type: "array",
            description: "email adresses",
            items: { type: "string", description: "Individual email address" },
          },
        },
        required: ["extraContext", "emails"],
      },
    },
  },
];

async function actionable(
  socket,
  userId,
  clientQuery,
  refreshToken,
  user_profile
) {
  console.log("profile: " + user_profile);

  // Add user query to conversation history
  addToConversation(socket.id, clientQuery, "user");

  const accessToken = "some-access-token"; // Replace with actual token retrieval

  // Call OpenAI with function calling enabled

  socket.emit("status", "retrieving tokens");

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: clientQuery }],
    tools: tools,
    tool_choice: "auto",
  });

  const toolCall = response.choices[0].message.tool_calls?.[0];
  console.log(response.choices[0].message);
  if (!toolCall) {
    const responseMessage = response.choices[0].message.content;
    addToConversation(socket.id, responseMessage, "assistant");
    socket.emit("response", { message: responseMessage });
    return;
  }

  const functionName = toolCall.function.name;
  const args = JSON.parse(toolCall.function.arguments);

  // Check if emailId is required
  const requiresEmailId = [
    "archiveEmails",
    "label",
    "forwardEmails",
    "draftResponse",
  ].includes(functionName);

  if (requiresEmailId) {
    let emailId = args.emailId;
    if (!emailId) {
      // If emailId isn't provided, search for it
      socket.emit("status", "searching emails for action");

      const extractContextPrompt = `The following is the user's query: "${clientQuery}".

      Your Task is to extract the part of the users query which can be used as context for a RAG query and return it. If the context is not found, return "None". The relevant context is the part of the query that can be used to find the email ID. The user's instructions for the content of the response is not relevant context.

      **Example:**
      Input: "I want you to draft a response to the email from charlie regarding the team meeting and tell him I cannot make it."
      Output: "team meeting with charlie"
    `;
      const extractContextResponse = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: extractContextPrompt }],
      });

      const extractedContext =
        extractContextResponse.choices[0].message.content.trim();

      if (extractedContext === "None") {
        const responseMessage = "not enought context given to extract email id";
        addToConversation(socket.id, responseMessage, "assistant");
        socket.emit("response", {
          message: responseMessage,
        });
        return;
      }
      const fullEmails = await retrieveFullEmail(userId, extractedContext); // Assume this function exists

      if (!fullEmails || fullEmails.length === 0) {
        const responseMessage = "No relevant emails found for the action.";
        addToConversation(socket.id, responseMessage, "assistant");
        socket.emit("response", {
          message: responseMessage,
        });
        return;
      }

      let emailIndex = 0;

      const askConfirmation = () => {
        if (emailIndex >= fullEmails.length) {
          const responseMessage =
            "No more emails to confirm. Action cancelled.";
          addToConversation(socket.id, responseMessage, "assistant");
          socket.emit("response", {
            message: responseMessage,
          });
          return;
        }

        const email = fullEmails[emailIndex];
        const formattedEmailContent = `
### Email Details
- **Labels**: ${
          email.content.split("Labels:")[1]?.split("Subject:")[0]?.trim() ||
          "N/A"
        }
- **Subject**: ${
          email.content.split("Subject:")[1]?.split("From:")[0]?.trim() || "N/A"
        }
- **From**: ${email.content.split("From:")[1]?.split("To:")[0]?.trim() || "N/A"}
- **To**: ${email.content.split("To:")[1]?.split("Date:")[0]?.trim() || "N/A"}
- **Date**: ${
          email.content.split("Date:")[1]?.split(" ")[0] +
            " " +
            email.content.split("Date:")[1]?.split(" ").slice(1, 5).join(" ") || // subject to change if does nto work //
          "N/A"
        }

### Message
${
  email.content.split("Date:")[1]?.split(" ").slice(5).join(" ") ||
  "No message body available"
}
  `.trim();

        const confirmationMessage = `
**Do you want to perform the action on this email?**

${formattedEmailContent}
  `.trim();
        socket.emit("status", "awaiting confirmation");
        socket.emit("confirmation", {
          message: confirmationMessage,
          emailId: email.emailId,
        });

        socket.once("confirmationResponse", async (response) => {
          if (response.toLowerCase() === "yes") {
            args.emailId = email.emailId;
            const result = await executeFunction(
              functionName,
              args,
              refreshToken,
              socket,
              user_profile
            );
            addToConversation(socket.id, result, "assistant");
            socket.emit("response", {
              message: result,
            });
          } else if (
            response.toLowerCase() === "cancel" ||
            response.toLowerCase() === "stop"
          ) {
            const responseMessage = "Ok! I will cancel the action immediately.";
            addToConversation(socket.id, responseMessage, "assistant");
            socket.emit("response", {
              message: responseMessage,
            });
            return;
          } else if (
            response.toLowerCase() === "next" ||
            response.toLowerCase() === "no"
          ) {
            emailIndex++;
            askConfirmation();
          } else {
            const responseMessage = "Please only respond with a Yes/No/Cancel";
            addToConversation(socket.id, responseMessage, "assistant");
            socket.emit("response", {
              message: responseMessage,
            });
            askConfirmation();
          }
        });
      };

      askConfirmation();
    } else {
      // If emailId is provided, execute directly
      const result = await executeFunction(
        functionName,
        args,
        refreshToken,
        socket,
        user_profile
      );
      addToConversation(socket.id, result, "assistant");
      socket.emit("response", {
        message: result,
      });
    }
  } else {
    // No emailId required (e.g., mass outreach draft)
    const result = await executeFunction(
      functionName,
      args,
      refreshToken,
      socket,
      user_profile
    );
    addToConversation(socket.id, result, "assistant");
    socket.emit("response", {
      message: result,
    });
  }
}

// Helper to execute the function based on name
async function executeFunction(
  functionName,
  args,
  refreshToken,
  socket,
  user_profile
) {
  socket.emit("status", "performing action");
  switch (functionName) {
    case "label":
      return await relabel(refreshToken, args.emailId, args.labelName, socket);
    case "draftResponse":
      return await singleDraft(
        refreshToken,
        args.extraContext,
        args.emailId,
        socket,
        user_profile
      );

    case "createNewDrafts":
      return massOutreachDraft(
        refreshToken,
        args.emails,
        args.extraContext,
        socket,
        user_profile
      );
    default:
      throw new Error("Unknown function");
  }
}

// Updated setupSocket to use the new classification

async function query(socket, userId, clientQuery, user_profile) {
  // Basic performance logging
  const startTime = Date.now();
  const logPerformance = (step, stepStartTime = Date.now()) => {
    const stepDuration = Date.now() - stepStartTime;
    const totalDuration = Date.now() - startTime;
    console.log(
      `[PERF] ${step}: ${stepDuration}ms | Total: ${totalDuration}ms`
    );
    return Date.now(); // Return current time for next step
  };

  console.log(user_profile + " HEELLO");

  // Add user query to conversation history
  addToConversation(socket.id, clientQuery, "user");

  socket.emit("status", "enhancing query with conversation context");

  try {
    // Enhance query with conversation context (disabled for now)
    const contextStartTime = Date.now();
    // const contextResult = await enhanceQueryWithContext(clientQuery, socket.id);
    const contextDuration = Date.now() - contextStartTime;

    console.log(
      `[PERF] Context Enhancement: ${contextDuration}ms | Total: ${
        Date.now() - startTime
      }ms`
    );
    console.log(`[CONTEXT] Using original query: "${clientQuery}"`);

    const rewritten_query = clientQuery;

    console.log("Rewritten Query:", rewritten_query);

    socket.emit("status", "searching emails");
    const retrievalStartTime = Date.now();

    const searchResult = await retrieveFullEmail(userId, rewritten_query);
    const retrievalDuration = Date.now() - retrievalStartTime;

    const fullEmails = searchResult.emails;
    const searchTiming = searchResult.searchTiming;

    // Log detailed breakdown with search timing
    console.log(
      `[PERF] Email Retrieval: ${retrievalDuration}ms | Total: ${
        Date.now() - startTime
      }ms`
    );
    console.log(
      `[PERF] Search Breakdown - Embedding: ${searchTiming.embedding}ms | Vector: ${searchTiming.vectorSearch}ms | Chunks: ${searchTiming.chunkRetrieval}ms | Total: ${searchTiming.total}ms`
    );

    if (!fullEmails || fullEmails.length === 0) {
      const noResultMessage = "No relevant emails found";
      addToConversation(socket.id, noResultMessage, "assistant");
      socket.emit("response", noResultMessage);
      return;
    }

    const currentDate = new Date().toISOString().split("T")[0];

    socket.emit("status", "generating response");
    const responseStartTime = Date.now();

    const prompt = `
    You are an AI assistant tasked with finding information from a user's emails and answering their questions. Strictly base your responses on the content of provided emails. Do  not incorporate external knowledge or speculate beyond what is explicitly stated in the emails. Responses should be accurate, concise, and formatted in clear Markdown.

**Date Context:**
- Today's date is: ${currentDate} (format: YYYY-MM-DD).
- For time references like "tomorrow," "next week," or "yesterday," use the **sent date** of the email as the reference, not today's date. Convert those into exact dates using the (YYYY-MM-DD) format for clarity.
- For example: If an email from 2025-03-01 mentions "meeting tomorrow," interpret that meeting to be on 2025-03-02.

**Emails for Input:**
${fullEmails
  .map(
    (email, index) =>
      `### Email ${index + 1}\n**ID:** ${email.emailId}\n**Content:** ${
        email.content
      }`
  )
  .join("\n\n")}

  This is the users profile: ${user_profile}, 

**User Question:** "${rewritten_query}"

**Output Requirements:**
- Base your answer **only** on the provided emails.
- If multiple emails are relevant for the query, find the most relevant ones and summarize that information.
- Don't regurgitate the email content; instead, provide a concise summary or answer based on the emails.
- When interpreting vague references (like "meeting next week"), use the date-time of the emails given to find the best one.
- If the answer cannot be determined from the emails, respond with - "**Hmm, No Luck Here:** Looks like these emails don't have quite enough to work with for this one."
- Include an array of the emailIds you used in forming your response.

**How I'll Respond:**
Here's the JSON format I'll use:
{
  "response": "A markdown-formatted answer with appropriate use of headers (##), bullet points, and minimal but clear emphasis (bold or italic) to ensure readability.",
  "emailIds": ["list", "of", "email", "IDs", "I", "leaned", "on"]
}
`;

    // STREAMING IMPLEMENTATION - Stream response in real-time for better UX
    console.log("🚀 Starting RAG response streaming...");
    socket.emit("stream_start"); // Signal client that streaming is starting

    let fullResponse = "";
    let emailIds = [];

    try {
      const stream = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content:
              "You are an assistant that provides the user with details regarding their emails.",
          },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        stream: true, // Enable streaming
      });

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || "";
        if (content) {
          fullResponse += content;
          // Log each chunk as it comes in
          // Stream each chunk to the client immediately
          socket.emit("stream_chunk", { chunk: content });
        }
      }

      // Parse the complete response to extract emailIds
      try {
        console.log("🔍 Full RAG response received:");
        console.log("=".repeat(80));
        console.log(fullResponse);
        console.log("=".repeat(80));

        const jsonResult = JSON.parse(fullResponse);
        emailIds = jsonResult.emailIds || [];

        console.log("📧 Parsed response content:", jsonResult.response);
        console.log("🔗 Email IDs used:", emailIds);

        // Add assistant response to conversation history
        addToConversation(socket.id, jsonResult.response, "assistant");

        // Send final response with metadata
        socket.emit("stream_complete", {
          fullResponse: jsonResult.response,
          emailIds: emailIds,
        });

        console.log("✅ Streaming complete. EmailIds:", emailIds);
        console.log(
          `[PERF] Response Generation: ${
            Date.now() - responseStartTime
          }ms | Total: ${Date.now() - startTime}ms`
        );
        console.log(
          `[PERF] Search Timing - Embedding: ${searchTiming.embedding}ms | Vector: ${searchTiming.vectorSearch}ms | Chunks: ${searchTiming.chunkRetrieval}ms | Search Total: ${searchTiming.total}ms`
        );
        console.log(`[PERF] Total Query Time: ${Date.now() - startTime}ms`);
      } catch (parseError) {
        console.error("❌ Failed to parse streamed JSON:", parseError);
        console.log("🔍 Raw response that failed to parse:");
        console.log("=".repeat(80));
        console.log(fullResponse);
        console.log("=".repeat(80));
        // Send the raw response if JSON parsing fails
        socket.emit("stream_complete", {
          fullResponse: fullResponse,
          emailIds: [],
        });
      }
    } catch (streamError) {
      console.error("❌ Streaming failed:", streamError);
      console.log("🔄 Falling back to non-streaming mode...");
      // Fallback to non-streaming if streaming fails
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
        response_format: { type: "json_object" },
      });

      const result = completion.choices[0].message.content;
      const jsonResult = JSON.parse(result);

      console.log("🔍 Fallback RAG response:");
      console.log("=".repeat(80));
      console.log(result);
      console.log("=".repeat(80));
      console.log("📧 Fallback parsed content:", jsonResult.response);
      console.log("🔗 Fallback email IDs:", jsonResult.emailIds);

      // Add assistant response to conversation history
      addToConversation(socket.id, jsonResult.response, "assistant");

      console.log(
        `[PERF] Fallback Response Generation: ${
          Date.now() - responseStartTime
        }ms | Total: ${Date.now() - startTime}ms`
      );
      console.log(
        `[PERF] Search Timing - Embedding: ${searchTiming.embedding}ms | Vector: ${searchTiming.vectorSearch}ms | Chunks: ${searchTiming.chunkRetrieval}ms | Search Total: ${searchTiming.total}ms`
      );
      console.log(`[PERF] Total Query Time: ${Date.now() - startTime}ms`);
      socket.emit("response", jsonResult);
    }
  } catch (error) {
    socket.emit("error", error.message);
  }
}

async function setupSocket(io) {
  console.log("Setting up Socket.IO");
  io.on("connection", (socket) => {
    const userId = socket.handshake.query.userId;
    const refreshToken = socket.handshake.query.refreshToken;
    const user_profile = socket.handshake.query.user_profile;

    if (!userId) {
      socket.emit("error", "Missing userId");
      socket.disconnect();
      return;
    }

    console.log(`A user connected with userId: ${userId}`);
    console.log(`A user connected with refreshToken: ${refreshToken}`);
    console.log(`A user connected with user_profile: ${user_profile}`);
    console.log(
      `[CONVERSATION] Socket ID: ${socket.id} - Starting new conversation`
    );

    let emailQueue = [];
    let currentQuery = null;

    // Handle disconnection to clean up conversation history
    socket.on("disconnect", () => {
      console.log(
        `[CONVERSATION] Socket ID: ${socket.id} - User disconnected, clearing conversation`
      );
      clearConversation(socket.id);
    });

    // Debug endpoint to view conversation history
    socket.on("debug_conversation", () => {
      const history = getConversationHistory(socket.id);
      const stats = getConversationStats();
      socket.emit("debug_response", {
        conversation: history,
        stats: stats,
      });
      console.log(`[DEBUG] Conversation history for ${socket.id}:`, history);
    });

    socket.on("actionable", async (data) => {
      const userId = socket.handshake.query.userId;
      if (!userId) {
        socket.emit("error", "Missing userId");
        socket.disconnect();
        return;
      }
      console.log(`Received actionable event for user ${userId}`);
      await actionable(io);
    });

    socket.on("fromclient", async (clientQuery) => {
      const userId = socket.handshake.query.userId;
      if (!userId) {
        socket.emit("error", "Missing userId");
        socket.disconnect();
        return;
      }

      if (!clientQuery) {
        socket.emit("error", "Missing query");
        return;
      }

      socket.emit("RAGQUERY");

      console.warn(`🟡 [QUERY] Raw query: "${clientQuery}"`);

      const enhancedQuery = await enhanceQueryWithContext(
        clientQuery,
        socket.id
      );

      if (enhancedQuery.contextUsed) {
        console.warn(
          `🟠 [QUERY] Enhanced query: "${enhancedQuery.enhancedQuery}"`
        );
        console.warn(
          `🟠 [QUERY] Enhancement reason: ${enhancedQuery.reasoning}`
        );
        clientQuery = enhancedQuery.enhancedQuery;
      } else {
        console.warn(
          `🟡 [QUERY] No enhancement needed: ${enhancedQuery.reasoning}`
        );
      }

      // use open ai call to classify user query:
      const classification = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content:
              "You are an assistant that classifies the user's query about their email inbox.",
          },
          {
            role: "user",
            content: `
      You will be given a query from a user about their email inbox. Your task is to classify the query into one of two categories:
      
      1. **search** – if the user is only asking to *search*, *look up*, or *retrieve* emails or information. These are passive queries that do not modify the inbox in any way. Examples:
         - "Can you find emails from John about the project?"
         - "What were my most recent messages from Amazon?"
         - "Do I have any unread emails about my flight?"
         - "Find the email from my bank regarding the loan application"
      
      2. **action** – if the user is asking to *take an action* on their inbox or an email, such as *label*, *archive*, *delete*, *reply*, *draft*, *mark as read/unread*, etc. These involve modifying or interacting with the inbox. Examples:
         - "Delete all emails from LinkedIn"
         - "Label the email from Bob as 'Important'"
         - "Draft a reply to the last email from my professor"
         - "Mark the flight confirmation email as unread"
         - "Can you find the email from my bank about the loan application and reply to it?"
      
      Your job is to respond with **only one word**: either **search** or **action**. Do not explain your reasoning.
      
      Now classify this query:
      "${clientQuery}"
      `,
          },
        ],
      });

      const classificationResponse = classification.choices[0].message.content;

      socket.emit("status", "classifying your query...");

      if (classificationResponse === "search") {
        // Call the query function with socket, userId, and the client's query
        socket.emit("status", "lets start processing your query...");
        console.log(user_profile);
        await query(socket, userId, clientQuery, user_profile);
      } else if (classificationResponse === "action") {
        // Call the command function with socket, userId, and the client's command
        socket.emit("status", "lets start processing your command...");
        await actionable(
          socket,
          userId,
          clientQuery,
          refreshToken,
          user_profile
        );
      }
    });
  });
}

module.exports = {
  setupSocket,
};

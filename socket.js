const { config } = require("dotenv").config();
const { retrieveFullEmail } = require("./RAGService");
const { OpenAI } = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const {
  relabel,
  singleDraft,
  massOutreachDraft,
  forwardEmails,
} = require("./gmailService");

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
async function getContextRelatednessScore(clientQuery, socketId) {
  const conversationHistory = getConversationHistory(socketId);

  if (conversationHistory.length === 0) {
    console.log("[CONTEXT] No conversation history, score: 0.0");
    return {
      score: 0.0,
      reasoning: "No previous conversation context available",
    };
  }

  // Get recent context (last 6 messages for relevance)
  const recentMessages = conversationHistory.slice(-6);
  const recentContext = recentMessages
    .map((msg) => `${msg.sender}: ${msg.message}`)
    .join("\n");

  console.log(
    `[CONTEXT] Analyzing relatedness with ${recentMessages.length} recent messages`
  );

  try {
    const scorePrompt = `You are analyzing whether a user's latest query is related to their previous conversation context.

**Conversation History (most recent):**
${recentContext}

**Latest User Query:** "${clientQuery}"

**Your Task:**
Determine how related the latest query is to the previous conversation context. Consider:

1. **Direct references** (pronouns like "that email", "he said", "the one we discussed", "reply to it")
2. **Topic continuity** (same subject, person, or project being discussed)
3. **Follow-up actions** (drafting responses, taking action on previously discussed items)
4. **Implicit context** (query makes more sense with previous context)

**Scoring Guidelines:**
- **0.9-1.0**: Clear direct references or pronouns that need context ("that email", "reply to it", "the meeting we discussed")
- **0.7-0.8**: Strong topic continuity (same person/project/subject as previous messages)
- **0.5-0.6**: Moderate relation (related but could stand alone)
- **0.3-0.4**: Weak relation (tangentially related topics)
- **0.0-0.2**: Unrelated (completely different topic/person/subject)

**Examples:**
- "project updates from Sarah" → "find that email again" = 0.95 (direct reference)
- "meeting with team" → "draft a response" = 0.85 (follow-up action)
- "contract terms" → "who is the project manager" = 0.75 (same project context)
- "project updates" → "find emails from bank" = 0.1 (unrelated topics)

**Response Format (JSON):**
{
  "score": 0.85,
  "reasoning": "Brief explanation of why this score was assigned"
}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a context relatedness analyzer that provides confidence scores for query-context relationships.",
        },
        {
          role: "user",
          content: scorePrompt,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    });

    const result = JSON.parse(response.choices[0].message.content);

    console.log(
      `[CONTEXT] Relatedness score: ${result.score} - ${result.reasoning}`
    );

    return result;
  } catch (error) {
    console.error("[CONTEXT] Error scoring relatedness:", error);
    return {
      score: 0.0,
      reasoning: "Error occurred during relatedness analysis",
    };
  }
}

async function enhanceQueryWithContext(clientQuery, socketId) {
  const conversationHistory = getConversationHistory(socketId);

  if (conversationHistory.length === 0) {
    console.log("[CONTEXT] No conversation history, using original query");
    return {
      enhancedQuery: clientQuery,
      contextUsed: false,
      reasoning: "No previous conversation context available",
    };
  }

  // Step 1: Get relatedness score
  const scoreResult = await getContextRelatednessScore(clientQuery, socketId);

  // Step 2: Decide based on confidence threshold
  const CONFIDENCE_THRESHOLD = 0.6;

  if (scoreResult.score < CONFIDENCE_THRESHOLD) {
    console.log(
      `[CONTEXT] ❌ Score ${scoreResult.score} below threshold ${CONFIDENCE_THRESHOLD}, using original query`
    );
    return {
      enhancedQuery: clientQuery,
      contextUsed: false,
      reasoning: `Low confidence score (${scoreResult.score}): ${scoreResult.reasoning}`,
    };
  }

  console.log(
    `[CONTEXT] ✅ Score ${scoreResult.score} above threshold ${CONFIDENCE_THRESHOLD}, enhancing query`
  );

  // Step 3: Enhance the query with context
  const recentMessages = conversationHistory.slice(-6);
  const recentContext = recentMessages
    .map((msg) => `${msg.sender}: ${msg.message}`)
    .join("\n");

  try {
    const contextPrompt = `You are enhancing a user query by adding conversation context. The query has already been determined to be related to previous conversation.

**Conversation History (most recent):**
${recentContext}

**Latest User Query:** "${clientQuery}"

**Your Task:**
Enhance the query by adding relevant context from the conversation history. Focus on:

1. **Direct references** - Replace pronouns with specific references
2. **Action context** - Add details needed for actions (drafting, replying, etc.)
3. **Search context** - Add specifics to help find relevant emails
4. **Topic details** - Include relevant people, projects, or subjects

**Enhancement Strategy by Query Type:**

**For SEARCH queries:** Add specific references to help find the right emails
**For ACTION queries:** Include ALL relevant context and details from the conversation since no RAG search will happen

**Response Format (JSON):**
{
  "enhancedQuery": "The improved query with context added",
  "reasoning": "Brief explanation of what context was added"
}

**Examples:**

**SEARCH Enhancement:**
- "find that email again" → "find the project update email from Sarah about Q4 timeline delays"
- "who is the project manager" → "who is the project manager for project xyz that Sarah mentioned"

**ACTION Enhancement:**
- "draft a response" → "draft a response to Sarah's project update email. Include context: Sarah mentioned Q4 timeline delays, budget concerns of $50k overrun, and need for additional resources."
- "reply saying I can't make it" → "reply to the meeting email saying I can't make it. Meeting context: scheduled for Friday 2pm, agenda includes budget review and Q1 planning."

Focus on making the query more specific and actionable while preserving the original intent.`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a query enhancement assistant that adds conversation context to user queries.",
        },
        {
          role: "user",
          content: contextPrompt,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    });

    const result = JSON.parse(response.choices[0].message.content);

    console.log(`[CONTEXT] 🔧 Enhanced query: "${result.enhancedQuery}"`);

    return {
      enhancedQuery: result.enhancedQuery,
      contextUsed: true,
      reasoning: `Enhanced (score: ${scoreResult.score}): ${result.reasoning}`,
    };
  } catch (error) {
    console.error("[CONTEXT] Error enhancing query:", error);
    return {
      enhancedQuery: clientQuery,
      contextUsed: false,
      reasoning: "Error occurred during context enhancement",
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
        "Add a label to one or multiple emails. Use this when the user explicitly asks to label or organize emails. If specific email IDs are provided in the user query, extract and use them.",
      parameters: {
        type: "object",
        properties: {
          emailIds: {
            type: "array",
            description: "array of email IDs to label (if multiple specified)",
            items: { type: "string", description: "Individual email ID" },
          },
          labelName: { type: "string", description: "Label to apply" },
        },
        required: ["labelName"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "forwardEmails",
      description:
        "Forward one or multiple emails to one or multiple recipients. Use this when the user wants to forward emails. If specific email IDs are provided in the user query, extract and use them.",
      parameters: {
        type: "object",
        properties: {
          emailIds: {
            type: "array",
            description:
              "array of email IDs to forward (if multiple specified)",
            items: { type: "string", description: "Individual email ID" },
          },
          recipients: {
            type: "array",
            description: "email addresses to forward to",
            items: { type: "string", description: "Individual email address" },
          },
          extraContext: {
            type: "string",
            description: "Optional message to include with the forwarded email",
          },
        },
        required: ["recipients"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "draftResponse",
      description:
        "Create draft replies to one or multiple emails. Use this when the user wants to respond to emails with message drafts. If specific email IDs are provided in the user query, extract and use them.",
      parameters: {
        type: "object",
        properties: {
          emailIds: {
            type: "array",
            description:
              "array of email IDs to reply to (if multiple specified)",
            items: { type: "string", description: "Individual email ID" },
          },
          extraContext: {
            type: "string",
            description:
              "Any additional instructions the user gives for the reply.",
          },
          attachments: {
            type: "array",
            description: "Files the user selected in the chat to attach.",
            items: {
              type: "object",
              properties: {
                fileName: { type: "string" },
                s3Key: { type: "string" },
              },
              required: ["fileName", "s3Key"],
            },
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
        "Create one or more new email drafts. Not replies to existing emails. Use this for outbound emails to new recipients. If user has selected emails, they will be used as reference context.",
      parameters: {
        type: "object",
        properties: {
          extraContext: {
            type: "string",
            description: "Draft content and instructions",
          },
          emails: {
            type: "array",
            description: "email addresses to send new drafts to",
            items: { type: "string", description: "Individual email address" },
          },
          referenceEmailIds: {
            type: "array",
            description:
              "optional array of email IDs to use as reference context (not recipients)",
            items: {
              type: "string",
              description: "Individual email ID for context",
            },
          },
          attachments: {
            type: "array",
            description: "Files the user selected in the chat to attach.",
            items: {
              type: "object",
              properties: {
                fileName: { type: "string" },
                s3Key: { type: "string" },
              },
              required: ["fileName", "s3Key"],
            },
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
  user_profile,
  attachments,
  SelectedEmails
) {
  try {
    console.log("profile: " + user_profile);
    console.log("[DEBUG] 2. Enter actionable() — attachments:", attachments);

    if (SelectedEmails === undefined) {
      SelectedEmails = [];
    }

    // Add user query to conversation history
    addToConversation(socket.id, clientQuery, "user");

    const accessToken = "some-access-token"; // Replace with actual token retrieval

    // Call OpenAI with function calling enabled

    socket.emit("status", "retrieving tokens");

    const sysBase =
      "You can attach any files provided via the `attachments` array when drafting emails.";
    const sysAttach =
      attachments && attachments.length
        ? "\nFiles selected:\n" +
          attachments.map((f) => `- ${f.fileName}`).join("\n")
        : "";

    console.log(
      "[DEBUG] 3. Before GPT call — using system prompt with files:",
      attachments.map((f) => f.fileName)
    );

    // If selectedEmails provided, add them to the context for the LLM
    let enhancedQuery = clientQuery;
    if (SelectedEmails.length > 0) {
      const emailIds = SelectedEmails.map((e) => e.emailId || e.id).join(", ");
      enhancedQuery = `${clientQuery}. Use these specific email IDs: ${emailIds}`;
      console.log(
        `[ACTION] Enhanced query with selected emails: ${enhancedQuery}`
      );
    }

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: sysBase + sysAttach,
        },
        { role: "user", content: enhancedQuery },
      ],
      tools: tools,
      tool_choice: "auto",
    });

    const toolCall = response.choices[0].message.tool_calls?.[0];
    console.log("[DEBUG] 4. GPT chose tool:", toolCall?.function.name);
    console.log(
      "[DEBUG] 4. Tool args.attachments:",
      toolCall?.function.arguments
    );
    console.log(response.choices[0].message);
    if (!toolCall) {
      const responseMessage = response.choices[0].message.content;
      addToConversation(socket.id, responseMessage, "assistant");
      socket.emit("response", { message: responseMessage });
      return;
    }

    const functionName = toolCall.function.name;
    const args = JSON.parse(toolCall.function.arguments);

    // If createNewDrafts and SelectedEmails provided, use them as reference context
    if (functionName === "createNewDrafts" && SelectedEmails.length > 0) {
      const referenceEmailIds = SelectedEmails.map((e) => e.emailId || e.id);
      args.referenceEmailIds = referenceEmailIds;
      console.log(
        `[ACTION] Using ${referenceEmailIds.length} selected emails as reference context for new drafts`
      );
    }

    // Check if emailId is required
    const requiresEmailId = [
      "archiveEmails",
      "label",
      "forwardEmails",
      "draftResponse",
    ].includes(functionName);

    if (requiresEmailId) {
      let emailId = args.emailId;

      // If SelectedEmails are provided, use them directly
      if (SelectedEmails.length > 0) {
        // For functions that handle multiple emails (like forwardEmails), pass the array
        if (functionName === "forwardEmails") {
          args.emailIds = SelectedEmails.map((e) => e.emailId || e.id);
        } else {
          // For single email functions, use the first selected email
          args.emailId = SelectedEmails[0].emailId || SelectedEmails[0].id;
        }

        console.log(
          `[ACTION] Using selected emails for ${functionName}:`,
          args.emailIds || args.emailId
        );

        const result = await executeFunction(
          functionName,
          args,
          refreshToken,
          socket,
          user_profile,
          attachments,
          SelectedEmails
        );
        addToConversation(socket.id, result, "assistant");
        socket.emit("response", {
          message: result,
        });
        return;
      }

      if (!emailId) {
        // If emailId isn't provided and no SelectedEmails, search for it
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
          const responseMessage =
            "not enought context given to extract email id";
          addToConversation(socket.id, responseMessage, "assistant");
          socket.emit("response", {
            message: responseMessage,
          });
          return;
        }

        let fullEmails;
        try {
          console.log(
            `[ACTION] Searching for emails with context: "${extractedContext}"`
          );
          const searchResult = await retrieveFullEmail(
            userId,
            extractedContext
          );
          fullEmails = searchResult.emails || searchResult; // Handle both formats

          console.log(`[ACTION] Search result:`, searchResult);
          console.log(`[ACTION] Full emails:`, fullEmails);

          if (!fullEmails || fullEmails.length === 0) {
            const responseMessage = "No relevant emails found for the action.";
            addToConversation(socket.id, responseMessage, "assistant");
            socket.emit("response", {
              message: responseMessage,
            });
            return;
          }
          console.log(`[ACTION] Found ${fullEmails.length} emails for action`);
        } catch (error) {
          console.error(`[ACTION] Error retrieving emails:`, error);
          const responseMessage =
            "Error occurred while searching for emails. Please try again.";
          addToConversation(socket.id, responseMessage, "assistant");
          socket.emit("response", {
            message: responseMessage,
          });
          return;
        }

        let emailIndex = 0;

        const askConfirmation = () => {
          if (
            !fullEmails ||
            !Array.isArray(fullEmails) ||
            emailIndex >= fullEmails.length
          ) {
            const responseMessage =
              "No more emails to confirm. Action cancelled.";
            addToConversation(socket.id, responseMessage, "assistant");
            socket.emit("response", {
              message: responseMessage,
            });
            return;
          }

          const email = fullEmails[emailIndex];
          if (!email || !email.content) {
            console.error(
              `[ACTION] Invalid email at index ${emailIndex}:`,
              email
            );
            emailIndex++;
            askConfirmation();
            return;
          }
          const formattedEmailContent = `
### Email Details
- **Labels**: ${
            email.content.split("Labels:")[1]?.split("Subject:")[0]?.trim() ||
            "N/A"
          }
- **Subject**: ${
            email.content.split("Subject:")[1]?.split("From:")[0]?.trim() ||
            "N/A"
          }
- **From**: ${email.content.split("From:")[1]?.split("To:")[0]?.trim() || "N/A"}
- **To**: ${email.content.split("To:")[1]?.split("Date:")[0]?.trim() || "N/A"}
- **Date**: ${
            email.content.split("Date:")[1]?.split(" ")[0] +
              " " +
              email.content
                .split("Date:")[1]
                ?.split(" ")
                .slice(1, 5)
                .join(" ") || // subject to change if does nto work //
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
                user_profile,
                attachments
              );
              addToConversation(socket.id, result, "assistant");
              socket.emit("response", {
                message: result,
              });
            } else if (
              response.toLowerCase() === "cancel" ||
              response.toLowerCase() === "stop"
            ) {
              const responseMessage =
                "Ok! I will cancel the action immediately.";
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
              const responseMessage =
                "Please only respond with a Yes/No/Cancel";
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
          user_profile,
          attachments
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
        user_profile,
        attachments
      );
      addToConversation(socket.id, result, "assistant");
      socket.emit("response", {
        message: result,
      });
    }
  } catch (error) {
    console.error(`[ACTION] Critical error in actionable function:`, error);
    const errorMessage =
      "Sorry, an error occurred while processing your action. Please try again.";
    addToConversation(socket.id, errorMessage, "assistant");
    socket.emit("response", {
      message: errorMessage,
    });
  }
}

// Helper to execute the function based on name
async function executeFunction(
  functionName,
  args,
  refreshToken,
  socket,
  user_profile,
  attachments
) {
  socket.emit("status", "performing action");
  switch (functionName) {
    case "label":
      return await relabel(
        refreshToken,
        args.emailIds || args.emailId,
        args.labelName,
        socket
      );
    case "draftResponse":
      const uiAttachment = attachments; // from socket payload
      const gptAttachment = args.attachments || []; // from GPT
      if (
        (!args.attachments || args.attachments.length === 0) &&
        attachments?.length
      ) {
        args.attachments = attachments;
      }
      const mergedAttachments = gptAttachment.map((g) => {
        const match = uiAttachment.find((u) => u.fileName === g.fileName);
        return match || g; // prefer UI version if found
      });

      console.log("[DEBUG] reply mergedAttachments:", mergedAttachments);
      return await singleDraft(
        refreshToken,
        args.extraContext,
        args.emailIds || args.emailId,
        socket,
        user_profile,
        mergedAttachments
      );

    case "createNewDrafts":
      const emails =
        Array.isArray(args.emails) && args.emails.length
          ? args.emails
          : [socket.handshake.query.userEmail || "me"]; // fallback to self
      const uiAttachments = attachments;
      const gptAttachments = args.attachments || [];
      const finalAttachments = gptAttachments.map((g) => {
        const match = uiAttachments.find((u) => u.fileName === g.fileName);
        return match || g;
      });

      console.log(
        "[DEBUG] downloading key will be:",
        finalAttachments[0]?.s3Key
      );
      console.log(
        "[DEBUG] 5. executeFunction → createNewDrafts — emails:",
        emails
      );

      if (
        emails.length === 1 &&
        emails[0].toLowerCase() ===
          (socket.handshake.query.userEmail || "").toLowerCase()
      ) {
        // Treat as a single reply
        return singleDraft(
          refreshToken,
          args.extraContext,
          args.emailIds || args.emailId,
          socket,
          user_profile,
          finalAttachments
        );
      }

      return massOutreachDraft(
        refreshToken,
        emails,
        args.extraContext,
        socket,
        user_profile,
        finalAttachments,
        args.referenceEmailIds
      );
    case "forwardEmails":
      return await forwardEmails(
        refreshToken,
        args.emailIds || args.emailId, // Handle both multiple and single email IDs
        args.recipients,
        socket,
        args.extraContext || ""
      );
    default:
      throw new Error("Unknown function");
  }
}

// Updated setupSocket to use the new classification

async function query(
  socket,
  userId,
  clientQuery,
  user_profile,
  SelectedEmails
) {
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
    let fullEmails;
    let searchTiming;

    if (SelectedEmails.length === 0) {
      // Perform RAG search
      const searchResult = await retrieveFullEmail(userId, rewritten_query);
      fullEmails = searchResult.emails;
      searchTiming = searchResult.searchTiming;
    } else {
      // Use pre-selected emails, normalize the structure
      fullEmails = SelectedEmails.map((email) => ({
        ...email,
        emailId: email.id || email.emailId, // Handle both id and emailId fields
      }));
      // No search performed, so create dummy timing
      searchTiming = {
        embedding: 0,
        vectorSearch: 0,
        chunkRetrieval: 0,
        total: 0,
      };
    }

    const retrievalDuration = Date.now() - retrievalStartTime;

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
- If multiple emails are relevant for the query, use the most relevant ones and awnser the users query and be descriptive.
- Don't regurgitate the email content; instead, provide a concise summary or answer based on the emails.
- When interpreting vague references (like "meeting next week"), use the date-time of the emails given to find the best one.
- If the answer cannot be determined from the emails, respond with - "**Hmm, No Luck Here:** Looks like these emails don't have quite enough to work with for this one."
- Include an array of the emailIds you used in forming your response.

BE FRIENDLY AND DESCRIPTIVE. DONT BE TOO CONCISE. 

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

    if (!refreshToken || refreshToken === "-1") {
      console.warn(
        `[AUTH] Invalid refresh token for user ${userId}: ${refreshToken}`
      );
      socket.emit(
        "error",
        "Invalid or missing refresh token. Please re-authenticate."
      );
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

    socket.on("fromclient", async (clientPayload) => {
      const text =
        typeof clientPayload === "string" ? clientPayload : clientPayload.text;
      const attachments =
        typeof clientPayload === "string"
          ? []
          : clientPayload.attachments || [];

      const SelectedEmails = clientPayload.emailContext || [];
      if (!SelectedEmails || SelectedEmails.length === 0) {
        console.log("No specific emails provided, using all emails");
      } else {
        console.log("Specific emails provided, using them");
      }
      let clientQuery = text;
      console.log(
        "[DEBUG] 1. After parsing payload — attachments:",
        attachments
      );
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
        await query(socket, userId, clientQuery, user_profile, SelectedEmails);
      } else if (classificationResponse === "action") {
        // Call the command function with socket, userId, and the client's command
        socket.emit("status", "lets start processing your command...");
        await actionable(
          socket,
          userId,
          clientQuery,
          refreshToken,
          user_profile,
          attachments,
          SelectedEmails
        );
      }
    });
  });
}

module.exports = {
  setupSocket,
};

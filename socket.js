const { config } = require("dotenv").config();
const { retrieveFullEmail } = require("./RAGService");
const { OpenAI } = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const { relabel, singleDraft, massOutreachDraft } = require("./gmailService");

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
      description: "Add a label to a specific email",
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
      name: "singleDraft",
      description: "Create a draft in response to a specific email",
      parameters: {
        type: "object",
        properties: {
          extraContext: { type: "string", description: "extra Draft content" },
        },
        required: ["extraContext"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "createMassOutreachDraft",
      description: "Create new outbound drafts for emails",
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

async function actionable(socket, userId, clientQuery, refreshToken) {
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
    socket.emit("response", { message: response.choices[0].message.content });
    return;
  }

  const functionName = toolCall.function.name;
  const args = JSON.parse(toolCall.function.arguments);

  // Check if emailId is required
  const requiresEmailId = [
    "archiveEmails",
    "label",
    "forwardEmails",
    "singleDraft",
  ].includes(functionName);

  if (requiresEmailId) {
    let emailId = args.emailId;
    if (!emailId) {
      // If emailId isn’t provided, search for it
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
        socket.emit("response", {
          message: "not enought context given to extract email id",
        });
        return;
      }
      const fullEmails = await retrieveFullEmail(userId, extractedContext); // Assume this function exists

      if (!fullEmails || fullEmails.length === 0) {
        socket.emit("response", {
          message: "No relevant emails found for the action.",
        });
        return;
      }

      let emailIndex = 0;

      const askConfirmation = () => {
        if (emailIndex >= fullEmails.length) {
          socket.emit("response", {
            message: "No more emails to confirm. Action cancelled.",
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
              socket
            );
            socket.emit("response", {
              message: result,
            });
          } else if (
            response.toLowerCase() === "cancel" ||
            response.toLowerCase() === "stop"
          ) {
            socket.emit("response", {
              message: "Ok! I will cancel the action immediately.",
            });
            return;
          } else if (
            response.toLowerCase() === "next" ||
            response.toLowerCase() === "no"
          ) {
            emailIndex++;
            askConfirmation();
          } else {
            socket.emit("response", {
              message: "Please only respond with a Yes/No/Cancel",
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
        socket
      );
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
      socket
    );
  }
}

// Helper to execute the function based on name
async function executeFunction(functionName, args, refreshToken, socket) {
  socket.emit("status", "performing action");
  switch (functionName) {
    case "label":
      return await relabel(refreshToken, args.emailId, args.labelName, socket);
    case "singleDraft":
      return await singleDraft(
        refreshToken,
        args.extraContext,
        args.emailId,
        socket
      );

    case "createMassOutreachDraft":
      return massOutreachDraft(
        refreshToken,
        args.emails,
        args.extraContext,
        socket
      );
    default:
      throw new Error("Unknown function");
  }
}

// Updated setupSocket to use the new classification

async function query(socket, userId, clientQuery) {
  socket.emit("status", "classifying emails");

  try {
    const rewrite_prompt = `The following is the user's query: "${clientQuery}". 

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

    socket.emit("status", "searching emails");

    const fullEmails = await retrieveFullEmail(userId, rewritten_query);

    if (!fullEmails || fullEmails.length === 0) {
      const noResult = {
        response: "No relevant emails found",
        emailIds: [],
      };
      socket.emit("response", noResult.response);
      return;
    }

    const currentDate = new Date().toISOString().split("T")[0];

    socket.emit("status", "generating response");

    const prompt = `
    You are an AI assistant tasked with finding information from a user's emails and answering their questions. Strictly base your responses on the content of provided emails. Do  not incorporate external knowledge or speculate beyond what is explicitly stated in the emails. Responses should be accurate, concise, and formatted in clear Markdown.

**Date Context:**
- Today’s date is: ${currentDate} (format: YYYY-MM-DD).
- For time references like "tomorrow," "next week," or "yesterday," use the **sent date** of the email as the reference, not today’s date. Convert those into exact dates using the (YYYY-MM-DD) format for clarity.
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

**User Question:** "${rewritten_query}"

**Output Requirements:**
- Base your answer **only** on the provided emails.
- If multiple emails are relevant for the query, find the most relevant ones and summarize that information.
- Don't regurgitate the email content; instead, provide a concise summary or answer based on the emails.
- When interpreting vague references (like "meeting next week"), use the date-time of the emails given to find the best one.
- If the answer cannot be determined from the emails, respond with - "**Hmm, No Luck Here:** Looks like these emails don’t have quite enough to work with for this one."
- Include an array of the emailIds you used in forming your response.

**How I’ll Respond:**
Here’s the JSON format I’ll use:
{
  "response": "A markdown-formatted answer with appropriate use of headers (##), bullet points, and minimal but clear emphasis (bold or italic) to ensure readability.",
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
      response_format: { type: "json_object" },
    });

    const result = completion.choices[0].message.content;
    const jsonResult = JSON.parse(result);

    console.log("Result:", jsonResult);

    socket.emit("response", jsonResult);
  } catch (error) {
    socket.emit("error", error.message);
  }
}

async function setupSocket(io) {
  console.log("Setting up Socket.IO");
  io.on("connection", (socket) => {
    const userId = socket.handshake.query.userId;
    const refreshToken = socket.handshake.query.refreshToken;

    if (!userId) {
      socket.emit("error", "Missing userId");
      socket.disconnect();
      return;
    }

    console.log(`A user connected with userId: ${userId}`);

    let emailQueue = [];
    let currentQuery = null;

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
        await query(socket, userId, clientQuery, refreshToken);
      } else if (classificationResponse === "action") {
        // Call the command function with socket, userId, and the client's command
        socket.emit("status", "lets start processing your command...");
        await actionable(socket, userId, clientQuery, refreshToken);
      }
    });
  });
}

module.exports = {
  setupSocket,
};

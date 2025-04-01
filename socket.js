const { config } = require("dotenv").config();
const { retrieveFullEmail } = require("./RAGService");
const { OpenAI } = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const { relabel, singleDraft } = require("./gmailService");

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
      description: "Create a draft for a specific email",
      parameters: {
        type: "object",
        properties: {
          extraContext: { type: "string", description: "extra Draft content" },
        },
        required: ["extraContext"],
      },
    },
  },
  //   {
  //     type: "function",
  //     function: {
  //       name: "createMassOutreachDraft",
  //       description: "Create a draft for mass outreach (no specific email)",
  //       parameters: {
  //         type: "object",
  //         properties: {
  //           accessToken: { type: "string", description: "User's access token" },
  //           context: { type: "string", description: "Draft content" },
  //         },
  //         required: ["accessToken", "context"],
  //       },
  //     },
  //   },
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

      Your Task is to extract the context part of the users query and return it. If the context is not found, return "None".

      **Example:**
      Input: "I want you to draft a response to the email from charlie regarding the team meeting."
      Output: "team meeting regarding charlie"
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
        const confirmationMessage = `Do you want to perform the action on this email? \n\n ${email.content}`;
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
          } else {
            emailIndex++;
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
    socket.emit("response", { message: result.message, emailIds: [] });
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
  "response": "A friendly, markdown-formatted answer! I’ll use headers (##), lists (- or *), starts with a **bold** flourish or some *italic* flair to keep things clear and engaging—short, helpful, and never dull.",
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
              "You are an assistant that provides the user with details regarding their emails.",
          },
          {
            role: "user",
            content:
              "Please categorize the following query as either a question or a command. If it's a question, respond with 'question'. If it's a command, respond with 'command'.",
          },
          { role: "user", content: clientQuery },
        ],
      });

      const classificationResponse = classification.choices[0].message.content;

      socket.emit("status", "classifying your query...");

      if (classificationResponse === "question") {
        // Call the query function with socket, userId, and the client's query
        socket.emit("status", "lets start processing your query...");
        await query(socket, userId, clientQuery, refreshToken);
      } else if (classificationResponse === "command") {
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

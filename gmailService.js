const axios = require("axios");
const https = require("https");

const agent = new https.Agent({ rejectUnauthorized: false });
const { google } = require("googleapis");
const { htmlToText } = require("html-to-text");
const { OpenAI } = require("openai");
const { raw } = require("express");
const { throwDeprecation } = require("process");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const AWS = require("aws-sdk");
const s3 = new AWS.S3({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

async function getOriginalEmailDetails2(accessToken, messageId) {
  const emailEndpoint = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`;

  try {
    const response = await axios.get(emailEndpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      params: {
        format: "full", // Get full message including headers
      },
    });

    const message = response.data;
    const headers = message.payload.headers;

    const fromHeader =
      headers.find((header) => header.name === "From")?.value || "";
    const subject =
      headers.find((header) => header.name === "Subject")?.value || "";
    const smtpMessageId =
      headers.find((header) => header.name === "Message-ID")?.value ||
      `<${messageId}@gmail.com>`; // Fallback
    const threadId = message.threadId;

    const emailRegex = /<([^>]+)>/;
    const fromMatch = fromHeader.match(emailRegex);
    const fromEmail = fromMatch ? fromMatch[1] : fromHeader;

    return {
      fromEmail, // Sender of the original email (for "To" in reply)
      subject, // Original subject
      smtpMessageId, // RFC 2822 Message-ID
      threadId, // Thread ID to link the draft
    };
  } catch (error) {
    console.error(
      "Error fetching email details:",
      error.response ? error.response.data : error.message
    );
    throw error;
  }
}

async function getOriginalSMTPMessageId(accessToken, gmailMessageId) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmailMessageId}?format=full`;
  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const headers = response.data.payload.headers || [];

  const messageIdHeader = headers.find(
    (header) => header.name.toLowerCase() === "message-id"
  );

  return messageIdHeader ? messageIdHeader.value : null;
}

async function getOriginalSubject(accessToken, messageId) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata`;
  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const headers = response.data.payload.headers;
  const subjectHeader = headers.find((h) => h.name.toLowerCase() === "subject");

  // Return the actual subject string if found
  return subjectHeader ? subjectHeader.value : "";
}

async function getAccessTokenFromRefreshToken(storedRefreshToken) {
  console.log("[OAUTH] using client_id:", process.env.CLIENT_ID);
  const tokenEndpoint = "https://oauth2.googleapis.com/token";

  // params needed to generate access token from endpoint
  const params = new URLSearchParams();
  params.append("client_id", process.env.CLIENT_ID);
  params.append("client_secret", process.env.CLIENT_SECRET);
  params.append("refresh_token", storedRefreshToken);
  params.append("grant_type", "refresh_token");

  try {
    const response = await axios.post(tokenEndpoint, params.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      httpsAgent: agent,
    });

    const newAccessToken = response.data.access_token;
    console.log("New access token:", newAccessToken);
    return newAccessToken;
    // sort of verifies the refresh token because will produce an error
    // if access token can't be generated
  } catch (error) {
    console.error("Error fetching access token:", error.response.data);
  }
}

function combineMetadataAndContent(emailData) {
  if (!emailData || !emailData.metadata || !emailData.content) {
    return "";
  }

  const { metadata, content } = emailData;
  const { headers, labels } = metadata;

  const relevantHeaders = ["Subject", "From", "To", "Cc", "Date"];

  const formattedHeaders = relevantHeaders
    .map((header) => {
      return headers[header] ? `${header}: ${headers[header]}` : "";
    })
    .filter((line) => line !== "")
    .join("\n");

  const labelsString = labels ? `Labels: ${labels}` : "";

  let combinedString = "";

  if (labelsString) {
    combinedString += `${labelsString}\n`;
  }

  if (formattedHeaders) {
    combinedString += `${formattedHeaders}\n\n`;
  }

  combinedString += `${content}`;

  return combinedString.trim();
}

// not currently using this
async function accessGmailApi(accessToken) {
  const gmailEndpoint =
    "https://gmail.googleapis.com/gmail/v1/users/me/messages";

  try {
    const response = await axios.get(gmailEndpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`, // use the access token here, tells gmail api we're using oAuth
        Accept: "application/json", // give response in json
      },
      params: { maxResults: 10 }, // only output max 10 messages
      httpsAgent: agent,
    });

    // extract all the message.id from response.data.message (array of messages)
    const messageIds = response.data.messages.map((message) => message.id);
    console.log("Gmail Messages:", messageIds);

    // fetch full details for each message
    for (const messageId of messageIds) {
      await getMessageDetails(messageId, accessToken);
    }
  } catch (error) {
    console.error(
      "Error accessing Gmail API:",
      error.response ? error.response.data : error.message
    );
  }
}

async function getMessageDetails(accessToken, messageId) {
  const messageEndpoint = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`;

  try {
    const response = await axios.get(messageEndpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`, // use the access token here, tells Gmail API we're using OAuth
        Accept: "application/json", // give response in json
      },
      httpsAgent: agent,
    });

    // Log the entire message to see its structure
    // console.log("Message Details:", response.data.id, response.data.snippet);

    // Extract the payload
    const payload = response.data.payload;

    // Function to get email content from the payload
    const getEmailContent = (payload) => {
      // Check if this is a simple message with body data (text or HTML)
      if (payload.body && payload.body.data) {
        if (payload.mimeType === "text/plain") {
          const encodedContent = payload.body.data;
          const decodedContent = Buffer.from(encodedContent, "base64").toString(
            "utf-8"
          );
          return decodedContent;
        } else if (payload.mimeType === "text/html") {
          const encodedHtml = payload.body.data;
          const decodedHtml = Buffer.from(encodedHtml, "base64").toString(
            "utf-8"
          );
          const plainText = htmlToText(decodedHtml, { wordwrap: false });
          return plainText;
        }
      }

      // Otherwise, look through the parts for text or HTML content
      if (payload.parts) {
        for (let part of payload.parts) {
          if (part.mimeType === "text/plain" && part.body && part.body.data) {
            const encodedContent = part.body.data;
            const decodedContent = Buffer.from(
              encodedContent,
              "base64"
            ).toString("utf-8");
            return decodedContent;
          } else if (
            part.mimeType === "text/html" &&
            part.body &&
            part.body.data
          ) {
            const encodedHtml = part.body.data;
            const decodedHtml = Buffer.from(encodedHtml, "base64").toString(
              "utf-8"
            );
            const plainText = htmlToText(decodedHtml, { wordwrap: false });
            return plainText;
          }
        }
      }

      return "No email content found";
    };

    const simplifyURL = (text) => {
      const urlRegex = /(https?:\/\/[^\s\[\]]+)/g;

      return text.replace(urlRegex, (url) => {
        try {
          const parsedUrl = new URL(url);
          const hostname = parsedUrl.hostname;
          return `[URL: ${parsedUrl.protocol}//${hostname}]`;
        } catch (error) {
          return url;
        }
      });
    };

    const getEmailMetadata = (response) => {
      if (!response.data.payload) {
        console.warn("Response payload is missing.");
        return {
          labels: "",
          headers: {},
        };
      }

      const labelIds = response.data.labelIds || [];
      const headers = response.data.payload.headers || [];

      const formattedHeaders = headers.reduce((acc, header) => {
        acc[header.name] = header.value;
        return acc;
      }, {});

      return {
        labels: labelIds.join(", "),
        headers: formattedHeaders,
      };
    };

    // Get the email content from the payload
    const emailContent = simplifyURL(getEmailContent(payload));

    const emailMetaData = getEmailMetadata(response);

    const MAX_CONTENT_LENGTH = 1000; // change as needed
    let finalContent = emailContent;
    if (emailContent.length > MAX_CONTENT_LENGTH) {
      finalContent = emailContent.substring(0, MAX_CONTENT_LENGTH) + "...";
    }
    const emailData = {
      metadata: emailMetaData,
      content: finalContent,
    };
    finalContent = combineMetadataAndContent(emailData);

    console.log("Email Content:", finalContent);

    return finalContent;
  } catch (error) {
    console.error(
      `Error fetching details for message ID ${messageId}:`,
      error.response ? error.response.data : error.message
    );
  }
}
// Function to fetch email history and return new messages
async function fetchEmailHistory(accessToken, historyId) {
  const gmailEndpoint = `https://gmail.googleapis.com/gmail/v1/users/me/history`;
  const params = {
    startHistoryId: historyId,
    labelId: "INBOX", // Only fetch inbox emails
  };

  try {
    const response = await axios.get(gmailEndpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      params,
    });

    // Log the Gmail API response to inspect its structure
    console.log("Gmail API Response:", response.data);

    // Check if there is a history object with messagesAdded
    if (response.data.history) {
      console.log("History found:", response.data.history);

      // Filters for events with messagesAdded (indicating new messages)
      const newMessages = response.data.history
        .filter((event) => event.messagesAdded)
        .map((event) => event.messagesAdded[0].message);

      console.log("New messages found:", newMessages);

      return newMessages; // Return new messages for further processing
    } else {
      console.log("No new messages or history found.");
      return []; // Return an empty array if no new messages
    }
  } catch (error) {
    console.error(
      "Error fetching email history:",
      error.response ? error.response.data : error.message
    );
    throw error; // Rethrow the error for higher-level error handling
  }
}

// this runs whenever the user is logged
// links user to pub/sub
async function watchGmailInbox(accessToken) {
  const gmailEndpoint = "https://gmail.googleapis.com/gmail/v1/users/me/watch";
  const requestBody = {
    labelIds: ["INBOX"], // only monitor the inbox
    topicName: "projects/inboxpilot-c4098/topics/gmail-watch",
  };

  try {
    const response = await axios.post(gmailEndpoint, requestBody, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
    console.log("Watch response:", response.data);
  } catch (error) {
    console.error(
      "Error setting up Gmail watch:",
      error.response ? error.response.data : error.message
    );
  }
}

// Helper function to apply a label to an email
async function applyLabelToEmail(accessToken, messageId, labelId) {
  const messageEndpoint = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`;

  try {
    await axios.post(
      messageEndpoint,
      {
        addLabelIds: [labelId], // Adds the specified label
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log(`Label ${labelId} applied to email ${messageId}`);
  } catch (error) {
    console.error(
      `Error applying label to message ID ${messageId}:`,
      error.response ? error.response.data : error.message
    );
  }
}

// Fetch email history and apply labels to new messages
async function fetchEmailHistoryAndApplyLabel(accessToken, historyId) {
  const gmailEndpoint = `https://gmail.googleapis.com/gmail/v1/users/me/history`;
  const params = {
    startHistoryId: historyId,
    labelId: "INBOX",
  };

  try {
    const response = await axios.get(gmailEndpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      params,
    });

    if (response.data.history) {
      const newMessages = response.data.history
        .filter((event) => event.messagesAdded)
        .map((event) => event.messagesAdded[0].message);

      console.log("New messages found:", newMessages);

      // Apply a label to each new message
      for (const message of newMessages) {
        await applyLabelToEmail(accessToken, message.id, "IMPORTANT"); // Use actual label ID
      }
    } else {
      console.log("No new messages or history found.");
    }
  } catch (error) {
    console.error(
      "Error fetching email history:",
      error.response ? error.response.data : error.message
    );
  }
}

async function fetchEmailHistoryWithRetry(
  accessToken,
  historyId,
  retries = 3,
  delay = 1000
) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const userMessages = await fetchEmailHistory(accessToken, historyId);
      if (userMessages.length > 0) {
        return userMessages; // If new messages are found, return them immediately
      }
      console.log("No new messages found, retrying...");
      await new Promise((resolve) => setTimeout(resolve, delay)); // Pause before retrying
    } catch (error) {
      console.error("Error fetching email history:", error.message);
    }
  }
  return []; // Return an empty array if no new messages are found after retries
}

// Helper function to get or create a label
async function getOrCreatePriorityLabel(accessToken, name) {
  const listLabelsEndpoint =
    "https://gmail.googleapis.com/gmail/v1/users/me/labels";
  const createLabelEndpoint =
    "https://gmail.googleapis.com/gmail/v1/users/me/labels";

  try {
    // Check if the label already exists
    const listResponse = await axios.get(listLabelsEndpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const existingLabel = listResponse.data.labels.find(
      (label) => label.name === name
    );
    if (existingLabel) {
      console.log(`Label ${name} exists with ID: ${existingLabel.id}`);
      return existingLabel.id;
    }

    // Create the "Priority" label if it doesn't exist
    const createResponse = await axios.post(
      createLabelEndpoint,
      {
        name: name,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log(`Created label ${name} with ID: ${createResponse.data.id}`);
    return createResponse.data.id;
  } catch (error) {
    console.error(
      "Error creating or retrieving label:",
      error.response ? error.response.data : error.message
    );
  }
}

async function favoriteEmail(accessToken, messageId) {
  const messageEndpoint = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`;

  // Not sure if it would work, but after some research, The only way to favourite an email is by labeing it as STARRED
  // labeling an email as STARRED is how gmail knows that it is a favourited email
  try {
    await axios.post(
      messageEndpoint,
      {
        addLabelIds: ["STARRED"], // Adds the "STARRED" label
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    // console.log(`Label ${labelId} applied to email ${messageId}`);
  } catch (error) {
    console.error(
      `Error applying label to message ID ${messageId}:`,
      error.response ? error.response.data : error.message
    );
  }
}

// async function createDraft(accessToken, threadId, messageDescription, messageId, toEmail) {
//   const draftEndpoint = "https://gmail.googleapis.com/gmail/v1/users/me/drafts";

//   console.log("toEmail:", toEmail);

//   const emailContent = [
//     `To: ${toEmail}`, // Use the extracted recipient email address
//     // `Subject: Test Draft Email`,
//     `In-Reply-To: <${messageId}>`,
//     `References: <${messageId}>`,
//     "",
//     messageDescription,
//   ].join("\r\n");

//   // Encode the email
//   const encodedMessage = Buffer.from(emailContent)
//     .toString("base64")
//     .replace(/\+/g, "-")
//     .replace(/\//g, "_")
//     .replace(/=+$/, ""); // Make it URL-safe by replacing special characters

//   try {
//     const response = await axios.post(
//       draftEndpoint,
//       {
//         message: {
//           raw: encodedMessage,
//           threadId: threadId,
//         },
//       },
//       {
//         headers: {
//           Authorization: `Bearer ${accessToken}`,
//           "Content-Type": "application/json",
//         },
//       }
//     );
//     console.log(`Draft created with ID: ${response.data.id}`);
//   } catch (error) {
//     console.error(
//       "Error creating draft email:",
//       error.response ? error.response.data : error.message
//     );
//   }
// }

// async function createDraft(
//   accessToken,
//   threadId,
//   messageDescription,
//   toEmail,
//   originalSMTPMessageId,
//   subject
// ) {
//   const draftEndpoint = "https://gmail.googleapis.com/gmail/v1/users/me/drafts";

//   // Create proper email MIME message
//   const emailContent = [
//     'Content-Type: text/plain; charset="UTF-8"',
//     "MIME-Version: 1.0",
//     "Content-Transfer-Encoding: 7bit",
//     `To: ${toEmail}`,
//     `Subject: Re: ${subject}`, // "Re:" prefix for replies
//     `In-Reply-To: ${originalSMTPMessageId}`,
//     `References: ${originalSMTPMessageId}`,
//     "", // Empty line separates headers from body
//     messageDescription,
//   ].filter(Boolean).join("\r\n");

//   // Encode the email
//   const encodedMessage = Buffer.from(emailContent)
//     .toString("base64")
//     .replace(/\+/g, "-")
//     .replace(/\//g, "_")
//     .replace(/=+$/, "");

//     const messagePayload = {
//       message: {
//         raw: encodedMessage,
//       }
//     };

//     if (threadId) {
//       messagePayload.message.threadId = threadId;
//     }

//   try {
//     const response = await axios.post(
//       draftEndpoint,
//       {
//         message: {
//           raw: encodedMessage,
//           threadId: threadId,
//         },
//       },
//       {
//         headers: {
//           Authorization: `Bearer ${accessToken}`,
//           "Content-Type": "application/json",
//         },
//       }
//     );
//     console.log(`Draft created with ID: ${response.data.id}`);

//     return response.data;
//   } catch (error) {
//     console.error(
//       "Error creating draft email:",
//       error.response ? error.response.data : error.message
//     );
//     throw error;
//   }
// }

async function createDraft(
  accessToken,
  threadId,
  messageDescription,
  toEmail,
  originalSMTPMessageId,
  subject,
  bool,
  attachments = []
) {
  const draftEndpoint = "https://gmail.googleapis.com/gmail/v1/users/me/drafts";

  if (attachments.length === 0) {
    // Plain-text draft (original behaviour)
    emailContent = [
      'Content-Type: text/plain; charset="UTF-8"',
      "MIME-Version: 1.0",
      "Content-Transfer-Encoding: 7bit",
      `To: ${bool ? toEmail : toEmail.fromEmail}`,
      `Subject: Re: ${subject}`,
      originalSMTPMessageId ? `In-Reply-To: ${originalSMTPMessageId}` : "",
      originalSMTPMessageId ? `References: ${originalSMTPMessageId}` : "",
      "",
      messageDescription,
    ]
      .filter(Boolean)
      .join("\r\n");
  } else {
    // Multipart with file attachments
    const boundary = "===CHATFILES===";
    emailContent =
      `Content-Type: multipart/mixed; boundary="${boundary}"\r\n` +
      "MIME-Version: 1.0\r\n" +
      `To: ${bool ? toEmail : toEmail.fromEmail}\r\n` +
      `Subject: Re: ${subject}\r\n` +
      (originalSMTPMessageId
        ? `In-Reply-To: ${originalSMTPMessageId}\r\nReferences: ${originalSMTPMessageId}\r\n`
        : "") +
      `\r\n--${boundary}\r\n` +
      'Content-Type: text/plain; charset="UTF-8"\r\n\r\n' +
      messageDescription +
      "\r\n";

    // Append each attachment
    for (const f of attachments) {
      console.log(process.env.S3_BUCKET);
      console.log("[DEBUG] downloading key:", f.s3Key);
      const { Body } = await s3
        .getObject({
          Bucket: process.env.S3_BUCKET,
          Key: f.s3Key,
        })
        .promise();

      emailContent +=
        `--${boundary}\r\n` +
        `Content-Type: application/octet-stream; name="${f.fileName}"\r\n` +
        "Content-Transfer-Encoding: base64\r\n" +
        `Content-Disposition: attachment; filename="${f.fileName}"\r\n\r\n` +
        Body.toString("base64") +
        "\r\n";
    }

    emailContent += `--${boundary}--`;
  }

  const encodedMessage = Buffer.from(emailContent)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const messagePayload = {
    message: {
      raw: encodedMessage,
    },
  };

  if (threadId) {
    messagePayload.message.threadId = threadId;
  }

  try {
    const response = await axios.post(draftEndpoint, messagePayload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    console.log(`Draft created with ID: ${response.data.id}`);
    console.log(`Draft created with message ID: ${response.data.message.id}`);
    return {
      draftId: response.data.id,
      messageId: response.data.message.id, // email id you're asking for
    };
  } catch (error) {
    console.error(
      "Error creating draft email:",
      error.response ? error.response.data : error.message
    );
    throw error;
  }
}

async function getOriginalEmailDetails(accessToken, messageId) {
  const emailEndpoint = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`;

  try {
    const response = await axios.get(emailEndpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      params: {
        format: "full", // Get the full message including headers
      },
    });

    const headers = response.data.payload.headers;
    const toHeader = headers.find((header) => header.name === "To");
    const fromHeader = headers.find((header) => header.name === "From");

    const toEmail = toHeader ? toHeader.value : null;
    const fromEmail = fromHeader ? fromHeader.value : null;

    console.log("To Email:", toEmail);
    console.log("From Email:", fromEmail);

    const emailRegex = /<([^>]+)>/;

    const match = fromEmail.match(emailRegex);

    var matchEmail;

    if (match === null) {
      console.log("No email found in From header:", fromEmail);
      matchEmail = fromEmail;
      return matchEmail;
    } else {
      matchEmail = match[1];
      console.log("Email found:", matchEmail);
      return matchEmail;
    }
  } catch (error) {
    console.error(
      "Error fetching email details:",
      error.response ? error.response.data : error.message
    );
    throw error; // Rethrow the error for further handling
  }
}

async function archiveEmail(accessToken, messageId) {
  const archiveEndpoint = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`;

  try {
    await axios.post(
      archiveEndpoint,
      {
        removeLabelIds: ["INBOX"],
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log(`Email ${messageId} archived successfully.`);
  } catch (error) {
    console.error(
      `Error archiving email ID ${messageId}:`,
      error.response ? error.response.data : error.message
    );
  }
}

async function forwardEmail(accessToken, messageId, forwardToEmail) {
  try {
    const emailContentEndpoint = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`;
    const sendEmailEndpoint = `https://gmail.googleapis.com/gmail/v1/users/me/messages/send`;

    const response = await axios.get(emailContentEndpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      params: {
        format: "raw",
      },
    });

    const rawEmailData = response.data.raw;

    const originalEmailBase64 = rawEmailData
      .replace(/-/g, "+")
      .replace(/_/g, "/");

    const forwardingMessage = createForwardingMessage(
      forwardToEmail,
      originalEmailBase64
    );

    const encodedMessage = Buffer.from(forwardingMessage)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    await axios.post(
      sendEmailEndpoint,
      { raw: encodedMessage },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log(
      `Email ${messageId} forwarded to ${forwardToEmail} successfully.`
    );
  } catch (error) {
    console.error(
      `Error forwarding email ID ${messageId}:`,
      error.response ? error.response.data : error.message
    );
  }
}

function createForwardingMessage(forwardToEmail, originalEmailBase64) {
  const originalEmail = Buffer.from(originalEmailBase64, "base64").toString(
    "utf-8"
  );

  const subjectMatch = originalEmail.match(/^Subject: (.*)$/m);
  const originalSubject = subjectMatch ? subjectMatch[1] : "No Subject";
  const subject = originalSubject.startsWith("Fwd:")
    ? originalSubject
    : `Fwd: ${originalSubject}`;

  const dateMatch = originalEmail.match(/^Date: (.*)$/m);
  const originalDate = dateMatch ? dateMatch[1] : "Unknown Date";

  const fromMatch = originalEmail.match(/^From: (.*)$/m);
  const originalFrom = fromMatch ? fromMatch[1] : "Unknown Sender";

  const toMatch = originalEmail.match(/^To: (.*)$/m);
  const originalTo = toMatch ? toMatch[1] : "Unknown Receiver";

  const forwardedHeader = [
    "---------- Forwarded message ---------",
    `From: ${originalFrom}`,
    `Date: ${convertToEST(originalDate)}`,
    `Subject: ${originalSubject}`,
    `To: ${originalTo}`,
    "",
  ].join("\n");
  console.log(forwardedHeader);

  const boundary = "----=_Part_0_123456789.987654321";

  const forwardingMessage = [
    `From: me`,
    `To: ${forwardToEmail}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    "",
    forwardedHeader,
    "",
    `--${boundary}`,
    `Content-Type: message/rfc822`,
    "",
    originalEmail,
    "",
    `--${boundary}--`,
  ].join("\n");

  return forwardingMessage;
}

function convertToEST(dateString) {
  const originalDate = new Date(dateString);

  const estDate = new Date(
    originalDate.toLocaleString("en-US", { timeZone: "America/New_York" })
  );

  const options = {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZone: "America/New_York",
  };

  const formattedDate = estDate.toLocaleString("en-US", options);

  return formattedDate.replace(/GMT[-+]\d{1,2}/, "EST");
}

async function createForwardingAddress(accessToken, forwardingEmail) {
  const forwardingAddressEndpoint = `https://gmail.googleapis.com/gmail/v1/users/me/settings/forwardingAddresses`;

  try {
    const response = await axios.post(
      forwardingAddressEndpoint,
      { forwardingEmail },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log(
      `Forwarding address ${forwardingEmail} created. Check your inbox to verify it if necessary.`
    );
  } catch (error) {
    console.error(
      `Error creating forwarding address:`,
      error.response ? error.response.data : error.message
    );
    return;
  }
}

async function checkForwardingVerification(accessToken, forwardingEmail) {
  const listEndpoint = `https://gmail.googleapis.com/gmail/v1/users/me/settings/forwardingAddresses`;

  const response = await axios.get(listEndpoint, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const forwardingAddresses = response.data.forwardingAddresses || [];
  return forwardingAddresses.some(
    (address) =>
      address.forwardingEmail === forwardingEmail &&
      address.verificationStatus === "accepted"
  );
}

async function createFilter(accessToken, forwardingEmail, criteria) {
  const filterEndpoint = `https://gmail.googleapis.com/gmail/v1/users/me/settings/filters`;

  try {
    const response = await axios.post(
      filterEndpoint,
      {
        criteria,
        action: { forward: forwardingEmail },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log(
      `Filter created successfully for forwarding to ${forwardingEmail}.`
    );
  } catch (error) {
    console.error(
      `Error creating filter for forwarding:`,
      error.response ? error.response.data : error.message
    );
  }
}
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

let Gmailprogress = 0;
let totalEmails = 500;
async function fetchLast50Emails(accessToken, progressCallback) {
  const totalEmails = 500; // Max emails to fetch
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  try {
    let messageIds = [];
    let nextPageToken = null;

    // Fetch message IDs
    while (messageIds.length < totalEmails) {
      const response = await gmail.users.messages.list({
        userId: "me",
        q: "category:primary", // Only fetch emails in the Primary category
        maxResults: Math.min(100, totalEmails - messageIds.length),
        pageToken: nextPageToken,
      });

      if (!response.data.messages || response.data.messages.length === 0) {
        console.log("No more emails found.");
        break;
      }

      messageIds = messageIds.concat(
        response.data.messages.map((msg) => msg.id)
      );
      nextPageToken = response.data.nextPageToken;
      if (!nextPageToken) break;
    }

    messageIds = messageIds.slice(0, totalEmails);
    if (messageIds.length === 0) {
      console.log("No emails found.");
      return [];
    }

    console.log(`Fetched ${messageIds.length} primary email IDs.`);

    // Fetch email details, skipping any that fail
    const emailDetails = [];
    for (let i = 0; i < messageIds.length; i++) {
      const messageId = messageIds[i];

      try {
        if (progressCallback) {
          await progressCallback(i + 1, messageIds.length);
        }

        const emailContent = await getMessageDetails(accessToken, messageId);
        await delay(500); // Prevent API rate limits

        emailDetails.push({
          messageId: messageId,
          content: emailContent,
        });

        console.log("Processed emails:", emailDetails.length);
      } catch (error) {
        console.warn(`Failed to fetch email ${messageId}, skipping:`, error);
        continue; // Skip this email and move to the next one
      }
    }

    console.log(`Successfully processed ${emailDetails.length} emails.`);
    return emailDetails;
  } catch (error) {
    // Handle errors in fetching message IDs (e.g., API authentication failure)
    console.error("Error fetching email IDs:", error);
    return []; // Return empty array if the initial fetch fails
  }
}

const fetchProgress = async () => {
  return Gmailprogress;
};

const resetProgress = () => {
  Gmailprogress = 0;
};

async function massOutreachDraft(
  refreshToken,
  emails,
  extraContext,
  socket,
  user_profile,
  attachments = [],
  referenceEmailIds = []
) {
  if (
    emails.length === 1 &&
    emails[0] === (socket.handshake.query.userEmail || "").toLowerCase()
  ) {
    // GPT accidentally used the outreach tool for a self-reply.
    return singleDraft(
      refreshToken,
      extraContext,
      /*emailId*/ null,
      socket,
      user_profile,
      attachments
    );
  }

  const bool = true;
  let draftNumber = 1;
  const accessToken = await getAccessTokenFromRefreshToken(refreshToken);

  // Extract context from reference emails if provided
  let referenceContext = "";
  if (referenceEmailIds && referenceEmailIds.length > 0) {
    socket.emit("status", "extracting context from reference emails");
    console.log(
      `[OUTREACH] Processing ${referenceEmailIds.length} reference emails for context`
    );

    try {
      const referenceContents = await Promise.all(
        referenceEmailIds.map((emailId) =>
          getMessageDetails(accessToken, emailId)
        )
      );

      // Generate context summary using OpenAI
      const contextPrompt = `
Analyze the following emails and extract key information that would be useful as context for drafting new emails:

${referenceContents
  .map(
    (content, index) => `
Email ${index + 1}:
${content}
`
  )
  .join("\n")}

Provide a concise summary of:
1. Key topics and decisions
2. Important dates or deadlines  
3. Relevant people and roles
4. Action items or conclusions
5. Any project or business context

Format as a clear, organized summary that can be used as reference context for new email drafts.
`;

      const contextCompletion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are an assistant that extracts and summarizes key information from emails to provide useful context for new communications.",
          },
          { role: "user", content: contextPrompt },
        ],
      });

      referenceContext = contextCompletion.choices[0].message.content;
      console.log(
        `[OUTREACH] Generated context summary from ${referenceEmailIds.length} reference emails`
      );
    } catch (error) {
      console.error("[OUTREACH] Error extracting reference context:", error);
      referenceContext =
        "Note: Could not extract context from reference emails.";
    }
  }

  const draftedMessageIds = []; // Store all messageIds
  let draftResponse;

  for (let email of emails) {
    socket.emit(
      "status",
      `drafting email ${draftNumber}/${emails.length} to ${email}`
    );

    const basePrompt = `
I want you to draft an email using the following instruction: ${extraContext}. Use the Users profile as additional context: ${user_profile}. The email should be of the same tone as the instruction.`;

    const referencePrompt = referenceContext
      ? `

Reference Context (use as background information, DO NOT reply to these emails):
${referenceContext}

Incorporate relevant information from the reference context into your new email draft where appropriate.`
      : "";

    const prompt = `${basePrompt}${referencePrompt}

Respond with a JSON object containing two fields: "subject" (the email subject line) and "emailContent" (the body of the draft email). Ensure the response is formatted as valid JSON.
`;
    const sysBase =
      "You can attach any files provided via the `attachments` array when drafting emails.";
    const sysAttach =
      attachments && attachments.length
        ? "\nFiles selected:\n" +
          attachments.map((f) => `- ${f.fileName}`).join("\n")
        : "";

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content:
            "You are an assistant that helps draft emails" +
            sysBase +
            sysAttach,
        },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
    });

    // Parse the JSON response
    console.log("Completion:", completion.choices[0].message.content);

    const response = JSON.parse(completion.choices[0].message.content);

    const emailContent = response.emailContent;
    const subject = response.subject;

    draftResponse = await createDraft(
      accessToken,
      undefined,
      emailContent,
      email,
      undefined,
      subject,
      bool,
      attachments
    );

    console.log(draftResponse.messageId);

    draftedMessageIds.push(draftResponse.messageId);

    draftNumber++;
  }

  console.log(
    `[OUTREACH] Completed ${draftedMessageIds.length}/${emails.length} drafts${
      referenceEmailIds.length > 0
        ? ` using ${referenceEmailIds.length} reference emails`
        : ""
    }`
  );

  const responseMessage = referenceContext
    ? `Emails drafted successfully using ${referenceEmailIds.length} reference emails for context`
    : "Emails drafted successfully";

  socket.emit("response", {
    message: responseMessage,
    emailIds: draftedMessageIds,
    referenceEmailIds:
      referenceEmailIds.length > 0 ? referenceEmailIds : undefined,
  });
}

async function singleDraft(
  refreshToken,
  extraContext,
  emailIds,
  socket,
  user_profile,
  attachments = []
) {
  const accessToken = await getAccessTokenFromRefreshToken(refreshToken);

  // Normalize input to array
  const emailArray = Array.isArray(emailIds) ? emailIds : [emailIds];
  const draftedMessageIds = [];
  let draftCount = 1;

  for (let emailId of emailArray) {
    socket.emit(
      "status",
      `drafting reply ${draftCount}/${emailArray.length} for email ${emailId}`
    );

    try {
      console.log(
        `[DRAFT] Processing email ${emailId} (${draftCount}/${emailArray.length})`
      );

      const emailContent = await getMessageDetails(accessToken, emailId);
      const latestEmail = await getOriginalEmailDetails2(accessToken, emailId);
      const originalSMTPMessageId = await getOriginalSMTPMessageId(
        accessToken,
        emailId
      );
      const subject = await getOriginalSubject(accessToken, emailId);

      const prompt = `Here is an email for which we need to draft a response or issue a follow up: ${emailContent}. Use additonal context from user profile: ${user_profile}. * Only use user profile information if its relevant!! * Please complete the email draft with a suitable response or follow up based on this extra context : ${extraContext}.  The response or follow up should be concise and should address the main points of the email. It should also be of the same tone as the original email. Only respond with the body of the draft email.`;

      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: "You are an assistant that helps draft emails.",
          },
          { role: "user", content: prompt },
        ],
      });

      const draftedEmail = completion.choices[0].message.content;
      console.log(`[DRAFT] Generated response for email ${emailId}`);

      let email_id = await createDraft(
        accessToken,
        latestEmail.threadId,
        draftedEmail,
        latestEmail,
        originalSMTPMessageId,
        subject,
        false,
        attachments
      );

      draftedMessageIds.push(email_id.messageId);
      console.log(
        `[DRAFT] Created draft ${email_id.messageId} for email ${emailId}`
      );
    } catch (error) {
      console.error(`[DRAFT] Error processing email ${emailId}:`, error);
      // Continue with other emails even if one fails
    }

    draftCount++;
  }

  const successCount = draftedMessageIds.length;
  const message =
    emailArray.length === 1
      ? "I have drafted the email"
      : `I have drafted ${successCount}/${emailArray.length} email responses`;

  socket.emit("response", {
    message: message,
    emailIds: draftedMessageIds,
    originalEmailIds: emailArray,
  });

  console.log(`[DRAFT] Completed ${successCount}/${emailArray.length} drafts`);
}

async function relabel(refreshToken, emailIds, labelName, socket) {
  console.log(refreshToken);
  const accessToken = await getAccessTokenFromRefreshToken(refreshToken);
  const labelId = await getOrCreatePriorityLabel(accessToken, labelName);

  // Normalize input to array
  const emailArray = Array.isArray(emailIds) ? emailIds : [emailIds];
  const labeledEmailIds = [];
  let labelCount = 1;

  for (let emailId of emailArray) {
    socket.emit(
      "status",
      `adding label "${labelName}" to email ${labelCount}/${emailArray.length}`
    );

    try {
      console.log(
        `[LABEL] Processing email ${emailId} (${labelCount}/${emailArray.length})`
      );

      await applyLabelToEmail(accessToken, emailId, labelId);
      labeledEmailIds.push(emailId);

      console.log(
        `[LABEL] Successfully labeled email ${emailId} with "${labelName}"`
      );
    } catch (error) {
      console.error(`[LABEL] Error labeling email ${emailId}:`, error);
      // Continue with other emails even if one fails
    }

    labelCount++;
  }

  const successCount = labeledEmailIds.length;
  const message =
    emailArray.length === 1
      ? `I have added "${labelName}" to the email`
      : `I have added "${labelName}" to ${successCount}/${emailArray.length} emails`;

  socket.emit("response", {
    message: message,
    emailIds: labeledEmailIds,
    labelName: labelName,
  });

  console.log(
    `[LABEL] Completed labeling ${successCount}/${emailArray.length} emails with "${labelName}"`
  );
}

async function forwardEmails(
  refreshToken,
  emailIds,
  recipients,
  socket,
  extraContext = ""
) {
  const accessToken = await getAccessTokenFromRefreshToken(refreshToken);

  // Normalize inputs to arrays
  const emailArray = Array.isArray(emailIds) ? emailIds : [emailIds];
  const recipientArray = Array.isArray(recipients) ? recipients : [recipients];

  const forwardedMessageIds = [];
  let forwardCount = 1;
  const totalForwards = emailArray.length * recipientArray.length;

  try {
    for (let emailId of emailArray) {
      for (let recipient of recipientArray) {
        socket.emit(
          "status",
          `forwarding email ${forwardCount}/${totalForwards} to ${recipient}`
        );

        try {
          // Get the original email details
          const emailContentEndpoint = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${emailId}`;
          const sendEmailEndpoint = `https://gmail.googleapis.com/gmail/v1/users/me/messages/send`;

          const response = await axios.get(emailContentEndpoint, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/json",
            },
            params: {
              format: "raw",
            },
          });

          const rawEmailData = response.data.raw;
          const originalEmailBase64 = rawEmailData
            .replace(/-/g, "+")
            .replace(/_/g, "/");

          // Create forwarding message with optional context
          const forwardingMessage = createForwardingMessageWithContext(
            recipient,
            originalEmailBase64,
            extraContext
          );

          const encodedMessage = Buffer.from(forwardingMessage)
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");

          const sendResponse = await axios.post(
            sendEmailEndpoint,
            { raw: encodedMessage },
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
            }
          );

          forwardedMessageIds.push(sendResponse.data.id);
          console.log(
            `Email ${emailId} forwarded to ${recipient} successfully.`
          );
        } catch (emailError) {
          console.error(
            `Error forwarding email ${emailId} to ${recipient}:`,
            emailError
          );
          // Continue with other forwards even if one fails
        }

        forwardCount++;
      }
    }

    const successCount = forwardedMessageIds.length;
    const message =
      successCount === totalForwards
        ? `Successfully forwarded ${emailArray.length} email(s) to ${recipientArray.length} recipient(s)`
        : `Forwarded ${successCount}/${totalForwards} emails (some may have failed)`;

    socket.emit("response", {
      message: message,
      emailIds: emailArray,
      recipients: recipientArray,
      forwardedMessageIds: forwardedMessageIds,
    });
  } catch (error) {
    console.error("Critical error in forwardEmails:", error);
    socket.emit("response", {
      message: "Error occurred while forwarding emails. Please try again.",
      emailIds: emailArray,
      recipients: recipientArray,
    });
  }
}

function createForwardingMessageWithContext(
  forwardToEmail,
  originalEmailBase64,
  extraContext = ""
) {
  const originalEmail = Buffer.from(originalEmailBase64, "base64").toString(
    "utf-8"
  );

  const subjectMatch = originalEmail.match(/^Subject: (.*)$/m);
  const originalSubject = subjectMatch ? subjectMatch[1] : "No Subject";
  const subject = originalSubject.startsWith("Fwd:")
    ? originalSubject
    : `Fwd: ${originalSubject}`;

  const dateMatch = originalEmail.match(/^Date: (.*)$/m);
  const originalDate = dateMatch ? dateMatch[1] : "Unknown Date";

  const fromMatch = originalEmail.match(/^From: (.*)$/m);
  const originalFrom = fromMatch ? fromMatch[1] : "Unknown Sender";

  const toMatch = originalEmail.match(/^To: (.*)$/m);
  const originalTo = toMatch ? toMatch[1] : "Unknown Receiver";

  // Add extra context if provided
  const contextMessage = extraContext.trim() ? `${extraContext}\n\n` : "";

  const forwardedHeader = [
    "---------- Forwarded message ---------",
    `From: ${originalFrom}`,
    `Date: ${convertToEST(originalDate)}`,
    `Subject: ${originalSubject}`,
    `To: ${originalTo}`,
    "",
  ].join("\n");

  const boundary = "----=_Part_0_123456789.987654321";

  const forwardingMessage = [
    `From: me`,
    `To: ${forwardToEmail}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    "",
    contextMessage,
    forwardedHeader,
    "",
    `--${boundary}`,
    `Content-Type: message/rfc822`,
    "",
    originalEmail,
    "",
    `--${boundary}--`,
  ].join("\n");

  return forwardingMessage;
}

module.exports = {
  accessGmailApi,
  getMessageDetails,
  fetchEmailHistory,
  watchGmailInbox,
  applyLabelToEmail,
  fetchEmailHistoryAndApplyLabel,
  getOrCreatePriorityLabel,
  fetchEmailHistoryWithRetry,
  archiveEmail,
  forwardEmail,
  createForwardingAddress,
  checkForwardingVerification,
  createFilter,
  createDraft,
  favoriteEmail,
  getOriginalEmailDetails,
  fetchLast50Emails,
  fetchProgress,
  resetProgress,
  massOutreachDraft,
  singleDraft,
  relabel,
  forwardEmails,
};

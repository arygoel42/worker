const { config } = require("dotenv").config();
const { OpenAI } = require("openai");
const { updateUserField } = require("./user");

if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY environment variable is required");
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Analyze email style using OpenAI
async function analyzeEmailStyle(emails) {
  try {
    const emailContent = emails
      .map(
        (email, index) =>
          `Email ${index + 1}:
Subject: ${email.subject || "No Subject"}
Date: ${email.date || "No Date"}
Content: ${email.content}`
      )
      .join("\n\n");

    const prompt = `
Analyze the writing style of these emails and provide a detailed style profile:

${emailContent}

Please analyze and return a JSON object with the following style characteristics:

{
  "common_phrases": ["list", "of", "frequently", "used", "phrases"],
  "greeting_style": "how they typically start emails and greet in the first line with specific examples",
  "closing_style": "how they typically end emails and sign off with specific examples",
  "writing_length": "how long winded they are when they write emails. Concise/moderate/verbose",
  "communication_preferences": "Key patterns in their communication style and voice. Not the kinds of emails they send, but the way they communicate in general.",
  "avoid_phrases": "Phrases, words, or constructions they avoid using in their emails (bullets, slangs, long paragraphs, etc.)",
  "style_guide": "A 3-5 bullet point list of how to write emails like this person. Include constructs they use like bullets, pragraph structure, etc."
}

Base your analysis only on the provided emails.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const styleAnalysis = JSON.parse(completion.choices[0].message.content);
    console.log("✅ Email style analysis completed");
    return styleAnalysis;
  } catch (error) {
    console.error("❌ Error analyzing email style:", error);
    throw error;
  }
}

// Update user profile with style analysis
async function updateUserStyleProfile(userId, styleAnalysis) {
  try {
    await updateUserField(userId, "emailStyle", styleAnalysis);
    await updateUserField(userId, "styleAnalyzedAt", new Date());
    console.log(`✅ Updated style profile for user ${userId}`);
  } catch (error) {
    console.error("❌ Error updating user style profile:", error);
    throw error;
  }
}

// Main function to analyze and save user email style
async function analyzeAndSaveUserStyle(userId, emails) {
  try {
    console.log(`🔍 Starting style analysis for user ${userId}...`);

    if (!emails || emails.length === 0) {
      throw new Error("No emails provided for analysis");
    }

    // Analyze email style
    const styleAnalysis = await analyzeEmailStyle(emails);

    // Update user profile
    await updateUserStyleProfile(userId, styleAnalysis);

    console.log(`✅ Style analysis complete for user ${userId}`);
    return styleAnalysis;
  } catch (error) {
    console.error("❌ Error in analyzeAndSaveUserStyle:", error);
    throw error;
  }
}

module.exports = {
  analyzeEmailStyle,
  updateUserStyleProfile,
  analyzeAndSaveUserStyle,
};

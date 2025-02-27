require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const admin = require("firebase-admin");

// Initialize Express App
const app = express();
const port = process.env.PORT || 5000;

app.use(express.json());
app.use(cors());

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "ai-thought-assistant-114",
});

const db = admin.firestore();

// OpenAI Assistants API Base URL
const OPENAI_API_URL = "https://api.openai.com/v1";

// Function to fetch the last stored Master File from Firestore
async function getLastMasterFile(userId) {
  try {
    const doc = await db.collection("master_files").doc(userId).get();
    return doc.exists ? doc.data().content : "No previous Master File available.";
  } catch (error) {
    console.error("Error fetching Master File:", error);
    return "Error fetching Master File.";
  }
}

// Function to save AI-generated content in Firestore
async function saveToFirestore(userId, collection, content) {
  try {
    await db.collection(collection).doc(userId).set({
      content,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error(`Error saving ${collection} to Firestore:`, error);
  }
}

// Function to create a new thread in OpenAI Assistants API
async function createThread() {
  try {
    const response = await axios.post(
      `${OPENAI_API_URL}/threads`,
      {},
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "OpenAI-Beta": "assistants=v2",
        },
      }
    );
    return response.data.id;
  } catch (error) {
    console.error("Error creating thread:", error.response ? error.response.data : error);
    throw new Error("Failed to create a new thread.");
  }
}

// Function to run an AI assistant and return its output
async function runAssistant(threadId, assistantId, userMessage) {
  try {
    // Send user input to OpenAI
    await axios.post(
      `${OPENAI_API_URL}/threads/${threadId}/messages`,
      { role: "user", content: userMessage },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "OpenAI-Beta": "assistants=v2",
        },
      }
    );

    // Run the assistant
    const response = await axios.post(
      `${OPENAI_API_URL}/threads/${threadId}/runs`,
      { assistant_id: assistantId },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "OpenAI-Beta": "assistants=v2",
        },
      }
    );

    // Wait for the assistant to complete processing
    let runStatus = response.data.status;
    let runId = response.data.id;
    while (runStatus !== "completed") {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const checkStatus = await axios.get(`${OPENAI_API_URL}/threads/${threadId}/runs/${runId}`, {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2",
        },
      });
      runStatus = checkStatus.data.status;
    }

    // Retrieve and return the final response
    const messagesResponse = await axios.get(`${OPENAI_API_URL}/threads/${threadId}/messages`, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2",
      },
    });
    return messagesResponse.data.data.pop().content;
  } catch (error) {
    console.error(`Error processing assistant (${assistantId}):`, error.response ? error.response.data : error);
    throw new Error(`Failed to execute assistant (${assistantId}).`);
  }
}

// Full AI Workflow - Processes Master File Updates
app.post("/api/process", async (req, res) => {
  try {
    const { brain_dump, trigger_brand_analysis } = req.body;
    if (!brain_dump) {
      return res.status(400).json({ error: "Brain Dump is required" });
    }

    const threadId = await createThread();
    const userId = "default_user";
    const previousMasterFile = await getLastMasterFile(userId);

    // Run each assistant in sequence
    const masterFileUpdate = await runAssistant(threadId, process.env.ASSISTANT_MASTER_FILE, brain_dump);
    await saveToFirestore(userId, "master_files", masterFileUpdate);

    const coreMessagingUpdate = await runAssistant(threadId, process.env.ASSISTANT_CORE_MESSAGING, masterFileUpdate);
    await saveToFirestore(userId, "core_messaging", coreMessagingUpdate);

    const identityProfileUpdate = await runAssistant(threadId, process.env.ASSISTANT_IDENTITY_PROFILE, coreMessagingUpdate);
    await saveToFirestore(userId, "identity_profiles", identityProfileUpdate);

    const socialContent = await runAssistant(threadId, process.env.ASSISTANT_SOCIAL_CONTENT, identityProfileUpdate);
    await saveToFirestore(userId, "social_content", socialContent);

    const contentFeedback = await runAssistant(threadId, process.env.ASSISTANT_CONTENT_FEEDBACK, socialContent);
    await saveToFirestore(userId, "ai_feedback", contentFeedback);

    let brandAnalysis = null;
    if (trigger_brand_analysis) {
      brandAnalysis = await runAssistant(threadId, process.env.ASSISTANT_BRAND_ANALYSIS, contentFeedback);
      await saveToFirestore(userId, "brand_analysis", brandAnalysis);
    }

    res.json({ thread_id: threadId, masterFileUpdate, coreMessagingUpdate, identityProfileUpdate, socialContent, contentFeedback, brandAnalysis });
  } catch (error) {
    console.error("Error in processing:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to process AI workflow." });
    }
  }
});

app.listen(port, () => console.log(`AI Backend is running on port ${port}`));

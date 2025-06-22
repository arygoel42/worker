const { db } = require("./firebaseService");

// Get user by userId
async function getUser(userId) {
  try {
    const userRef = db.collection("Users").doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return null;
    }

    return userDoc.data();
  } catch (error) {
    console.error("Error getting user:", error);
    throw error;
  }
}

// Update user field (creates user if doesn't exist)
async function updateUserField(userId, fieldName, fieldValue) {
  try {
    const userRef = db.collection("Users").doc(userId);
    await userRef.set(
      {
        [fieldName]: fieldValue,
        updatedAt: new Date(),
      },
      { merge: true }
    );
    console.log(`Updated ${fieldName} for user ${userId}`);
  } catch (error) {
    console.error("Error updating user field:", error);
    throw error;
  }
}

module.exports = {
  getUser,
  updateUserField,
};

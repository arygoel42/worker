const admin = require("firebase-admin");

// Service account configuration
const serviceAccount = {
  type: "service_account",
  project_id: "inboxpilot-c4098",
  private_key_id: "febada5cab56ec3b29fa607e95471dc9da1fb44c",
  private_key:
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDkJiYTHazYC3wf\nboe1Km5DZxR3tJWdjtw2g442DENJYH4OPN9uzls2aj3U2B8jGCKLYklqLtCTaRVZ\nYPRciG81d85w0OpQuT2Q68sE91XjUeJjkPRxQdvrp+aWmSKC/1NWqU7cH9eLwJPk\nEOm8INlpwNZGd8zdYYsQu4DLHAN+tSkNsdSQovjCz6TFeJPnjJjh0rUTte4WNOYf\nOruVkkvSMXgm+dvf+zBK6q7yVspMUZ7m3lP+hAhNOc+WNL9/1PKkZKAD0WdKaKDe\nV8D6ORxYwWpeVdwPCDlL7rBwn6U+Kjy/HJpOVh7PQFqxB70waLiiHz218soXy1JF\nd5kE58TVAgMBAAECggEAIStwtAJyUN4T7N1HgAM2u7hJWqwCZ+v6FTeO3fRuIJrA\nSPajBLueDu0Rp0JyqHSyVQce+v/qatFyJ/1MxFqWUd+PaondKeD8qUy2xraPofiT\njFE/UMC3+2zSPV6Z4hIX/jdS/qA8g2t7X5hGkIegGbF5FblbgMDVP0NbfWwfD/Ul\nb13wQZFVdWf3KEeibm11j+TaMLIHBEnfUe8cl0qqKGbcm/lz7xoyfYAyMB0WyIaE\nYNbLUZLplyD2/kc8sFIO3aVWwgtnCZxTOQTBNkmrIHJVU1qcbV8/Q0O5A5CGuuh5\nZvS0yUH4VMKqaRxEoQgILEhLqPFGS0HZtiGeDV92QwKBgQD2p4+PHCmFiKXRUh7Z\noOtck2Qai9OmSTqf211UVO2xqEMyfzknT/oOBk8kdM9psVvXbyGFtzc4GKypEXqF\ndMATxtAW29Aw8DIIX1YYs+2/8kJfgcrNF0DLOhlzXaMTpEIiSXP5X1f3iqsjEuKp\nxMUB0CpHJVpDnl7ZqUCu8wmVMwKBgQDsyxe6Fmh8prziefqehjzSgDTvL2g8triA\n/oDTU3PUaB65JWOTSjP8yorme0YAhffkEDUGjCosA/7Wf/mBa5e4YrDWyOE5XsQ8\n3jVUxw59bl6cOoqktyvCYnszrj/gvMDIeF6TIixhob4FLf1fVOREbCR+YRGO1pjY\nEA4ESdit1wKBgFDiI7aHQqpyZAXfSxSMq4HBJ5t47N/jtaDEO7ey3ftbNSXzCFf2\n5wYAVaWb1IRRT8+2tqR1r1rq5HvQqn/nCDG0CXrlfEEAEzgho0cYgcdm9xMAqfNV\nQ78g/0WQmDCRtcoukiRdeqhHRdWLlN6dEwmELMkF27K+1VXFJdv5ANR3AoGAUeJd\nXx12nnxuXwb9cqpLCCQLqhbDvhMVtI3N8MYwDOjAjxft2jZTyfwkklVYvL+XHIe6\nPnxj7PqounZgyq9xNPLz4iJvOA6cX8wbtyhqy1dKYk4gOZuaB0tU/Wcpccb0B58Q\nXWL44/4xnsrrjnblxP98kzNwBewRyM2sezEqO9sCgYEA1923wI6ZmhIrtBo9VATz\nQWLVXShX6LWLI1nwo3pLEipp2B2HKOD9XHSLjQdUyBhzK4bVCfUzvaxOChOWZdTK\nczlehccqMrfN+HcbR8bYYH0abEthyJi3qv7TCxMPX8w0EK6MzrJdOUX3BrcKOjFq\nVG48VH0C3CtdAdxceoOXfHA=\n-----END PRIVATE KEY-----\n",
  client_email:
    "firebase-adminsdk-8j22p@inboxpilot-c4098.iam.gserviceaccount.com",
  client_id: "101000299353387593764",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url:
    "https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-8j22p%40inboxpilot-c4098.iam.gserviceaccount.com",
  universe_domain: "googleapis.com",
};

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

module.exports = { admin, db };

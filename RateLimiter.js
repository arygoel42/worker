// rateLimiter.js
const { RateLimiterMemory } = require("rate-limiter-flexible");

// Configure the rate limiter: allow 5 upserts per second by default
const UPSERTS_PER_SECOND = parseInt(process.env.UPSERTS_PER_SECOND) || 1;
const upsertRateLimiter = new RateLimiterMemory({
  points: UPSERTS_PER_SECOND, // Max number of upserts per second
  duration: 1, // Time window in seconds
});

module.exports = { upsertRateLimiter };

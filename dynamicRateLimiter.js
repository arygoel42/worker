class DynamicRateLimiter {
  constructor() {
    this.activeOnboardingJobs = new Set();
    this.baseDelays = {
      email: 100,     // Base delay for email fetching (ms)
      embedding: 50,  // Base delay for embedding requests (ms)
      pinecone: 200,  // Base delay for Pinecone operations (ms)
    };
    this.maxConcurrency = {
      email: 10,      // Max concurrent email fetches
      embedding: 5,   // Max concurrent embedding requests
      pinecone: 8,    // Max concurrent Pinecone operations
    };
  }

  addOnboardingJob(jobId) {
    this.activeOnboardingJobs.add(jobId);
  }

  removeOnboardingJob(jobId) {
    this.activeOnboardingJobs.delete(jobId);
  }

  getActiveJobCount() {
    return this.activeOnboardingJobs.size;
  }

  getDelay(operation) {
    const activeJobs = this.getActiveJobCount();
    const baseDelay = this.baseDelays[operation] || 100;
    
    if (activeJobs <= 1) {
      // Single job: minimal delay for maximum speed
      return Math.max(10, baseDelay * 0.1);
    }
    
    // Multiple jobs: scale delay based on concurrent jobs
    const scaleFactor = Math.min(activeJobs, 10); // Cap at 10x
    return baseDelay * scaleFactor;
  }

  getConcurrency(operation) {
    const activeJobs = this.getActiveJobCount();
    const maxConcurrency = this.maxConcurrency[operation] || 5;
    
    if (activeJobs <= 1) {
      // Single job: max concurrency
      return maxConcurrency * 2;
    }
    
    // Multiple jobs: reduce concurrency to prevent overwhelming APIs
    return Math.max(1, Math.floor(maxConcurrency / Math.min(activeJobs, 5)));
  }

  async delay(operation) {
    const delayMs = this.getDelay(operation);
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  // Batch processing with dynamic concurrency
  async processBatch(items, processor, operation) {
    const concurrency = this.getConcurrency(operation);
    const results = [];
    
    for (let i = 0; i < items.length; i += concurrency) {
      const batch = items.slice(i, i + concurrency);
      const batchPromises = batch.map(async (item, index) => {
        try {
          const result = await processor(item, i + index);
          await this.delay(operation);
          return result;
        } catch (error) {
          console.warn(`Batch item ${i + index} failed:`, error);
          return { error, index: i + index };
        }
      });
      
      const batchResults = await Promise.allSettled(batchPromises);
      results.push(...batchResults.map(r => r.value || r.reason));
    }
    
    return results;
  }
}

module.exports = new DynamicRateLimiter();
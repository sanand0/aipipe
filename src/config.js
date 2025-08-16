// Set a budget limit for specific email IDs or domains
const budget = {
  "*": { limit: 0.1, days: 7 }, // Default fallback: low limits for unknown users. Use 0.001 to limit to free models.
  "blocked@example.com": { limit: 0, days: 1 }, // Blocked user: zero limit stops all operations
  "user@example.com": { limit: 10.0, days: 30 }, // Premium user with monthly high-volume allocation
  "@example.com": { limit: 1.0, days: 7 }, // Domain-wide policy: moderate weekly quota for organization
  "@study.iitm.ac.in": { limit: 1.0, days: 30 }, // IITM Students: $1 / month
  "@ds.study.iitm.ac.in": { limit: 1.0, days: 30 }, // IITM Students: $1 / month
  "*@straive.com": { limit: 1.0, days: 1 }, // Straive: $1 / day
  "*@gramener.com": { limit: 1.0, days: 1 }, // Gramener: $1 / day
};

// If a user reports their key as stolen, add/change their salt to new random text.
// That will invalidate their token.
const salt = {
  "user@example.com": "random-text",
};

export { budget, salt };

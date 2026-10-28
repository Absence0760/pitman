// Global test setup — populates all the env vars the backend expects,
// so tests run in a configured state without hitting real services.
// Individual tests can use vi.stubEnv() to override or unset specific
// vars for "what happens when X is missing" coverage.

process.env.ALLOWED_ORIGINS = 'http://localhost:7777';
process.env.SITE_URL = 'http://localhost:7777';

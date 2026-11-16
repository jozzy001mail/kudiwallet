// Vercel serverless entry — re-exports the Express app from server.js.
// Static files in public/ are served by Vercel directly; /api/* and
// /health are rewritten here by vercel.json.
import app from '../server.js';

export default app;

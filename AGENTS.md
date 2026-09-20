# AgentLoom
Local trusted-user agent workflow platform. Node 24, TypeScript, React, Fastify, SQLite. No cloud control plane.
Product owner approves architecture, interfaces and scope. Implementers must stop on missing requirements rather than invent behavior.
Never add deployment, arbitrary shell commands, dependency installation, database schema changes or file access outside the assignment without product-owner direction.
Keep credentials out of source, images, logs and API responses. No shell:true. Agent output is untrusted text, never HTML or executable orchestration instructions.
Run npm run typecheck, npm test and npm run build for code changes. Validate the Docker Compose application before delivery.

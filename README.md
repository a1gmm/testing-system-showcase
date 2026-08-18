# Environmental Testing LIMS Showcase

This is a sanitized public snapshot of a production-oriented laboratory
information management system for environmental sampling and testing.

The application covers contracts, sampling plans, field records, sample
handover, laboratory work, quality control, reports, audit trails, and an
offline-first mobile sampling workflow.

## Technology

- Vue 3, TypeScript, Vite, Pinia, and Element Plus
- Node.js HTTP server and SQLite
- Vitest frontend tests and Node.js backend tests
- Offline-first PWA foundations for field sampling

## Run locally

```bash
pnpm -C web install --frozen-lockfile
pnpm -C web dev
```

In a second terminal:

```bash
cd server
npm start
```

The backend uses a local SQLite database created at runtime. Use fictional data
only when evaluating the showcase.

## Tests

```bash
pnpm -C web test
pnpm -C web build
cd server && npm test
```

## Repository policy

This repository is generated from a private source repository through an
allowlisted, sanitized export. It contains no production database, uploads,
customer documents, credentials, infrastructure configuration, or private Git
history. Direct changes here may be overwritten; proposed improvements should
be raised as an issue so they can be applied at the source and exported again.

All organizations, people, addresses, phone numbers, and sample records shown
in this public version are fictional.

## Updates

Changes from the private source are exported to a review branch automatically.
Each update is merged only after the sanitized public diff has been reviewed.

# ReconcileOps

Automated zero-downtime schema migration framework for microservices (capstone project).
See `docs/ARCHITECTURE.md` for scope, decisions and the phase plan.

## Status
Phase 1 complete: the reconciliation engine (`backend/src/engine`) with unit tests.
Everything else is planned but **not built yet**.

## Run the tests that exist today
```bash
cd backend
npm test          # needs Node 20+; no dependencies to install
```

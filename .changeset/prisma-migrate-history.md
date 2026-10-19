---
'lens': minor
---

Adopt Prisma migrate: commit a baseline migration (`prisma/migrations/0_init`), make CI fail on drift between `schema.prisma` and the migrations, switch app startup and deploys to `prisma migrate deploy`, and remove the `db push` path.

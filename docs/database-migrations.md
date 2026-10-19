# Database migrations

Issue **#233**. Before this, `prisma/` contained only `schema.prisma` — there was
no `migrations/` directory, and every schema change was applied with
`prisma db push`. Lens now uses **`prisma migrate`**: schema changes are
committed as reviewable SQL, and deployments apply them with `migrate deploy`.

## Why not `db push`

`prisma db push` diffs the *live* database against `schema.prisma` and applies
whatever it decides, on the spot. That gives you none of the things a service
that holds money-moving data needs:

- **Nothing is reviewable.** A schema change is whatever the diff produced at
  that instant, not a file a reviewer read.
- **No reproducible deploy.** Two environments pushed at different times can
  land on different shapes; nothing in the repo describes the live shape.
- **No rollback.** There is no record of what changed, so there is nothing to
  undo. With `--accept-data-loss` a push can silently drop a column.
- **It has already bitten us.** A `db push` in the sibling service half-applied
  and left the database on a shape no commit described. That is exactly the
  failure `prisma migrate` exists to prevent.

So: **do not run `prisma db push` against any environment.** It is no longer a
`package.json` script. The `db push` call at app startup (`src/index.ts`) now
runs `migrate deploy` instead.

## What lives in the repo now

```
prisma/
  schema.prisma                     # the source of truth for the data model
  migrations/
    migration_lock.toml             # provider = "postgresql" (do not hand-edit)
    0_init/
      migration.sql                 # baseline: recreates the production schema exactly
```

`0_init/migration.sql` is the **baseline** — the SQL that reproduces the current
production schema from an empty database. It is generated, not hand-written:

```bash
prisma migrate diff \
  --from-empty \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/0_init/migration.sql
```

## Daily workflow (local development)

Edit `schema.prisma`, then generate a migration. Do **not** `db push`.

```bash
npm run db:migrate        # prisma migrate dev — creates and applies a new migration
```

`migrate dev` writes a new timestamped folder under `prisma/migrations/`.
**Commit that folder.** It is now the reviewable record of the change.

```bash
npm run db:status         # which migrations are applied / pending
npm run db:reset          # drop schema and re-apply all migrations (NEVER on prod)
```

## Deploying

Deploys apply committed migrations only — they never diff the live database:

```bash
npm run db:deploy         # prisma migrate deploy
```

App startup (`src/index.ts`) runs `migrate deploy` for you, so a container that
starts against a database with pending migrations applies them and only them,
deterministically, or fails loudly if the database is ahead of the code.

### Adopting the baseline on an EXISTING production database

Production already matches `schema.prisma`, so the baseline's `CREATE TABLE`
statements must **not** be re-run there — `migrate deploy` would collide with
the tables that are already there. Instead, mark the baseline as already applied
without executing it, which records it in Prisma's `_prisma_migrations` table:

```bash
npx prisma migrate resolve --applied 0_init
```

After that, `migrate deploy` sees `0_init` as applied and only runs future
migrations. This one-time step is the standard Prisma path for adopting
`migrate` on a database that already exists; it is why the baseline is committed
separately rather than generated on deploy.

## The CI drift guard

The `db-migrations` job in `.github/workflows/ci.yml` brings up a Postgres
service and runs:

- `scripts/db-drift-check.sh` — deploys every committed migration, then
  `migrate diff --from-migrations prisma/migrations --to-schema-datamodel
  prisma/schema.prisma --exit-code` against a shadow database. It exits non-zero
  — failing CI — whenever `schema.prisma` and `prisma/migrations` disagree. This
  is the check that would have caught a half-applied `db push`.
- `scripts/db-migration-cycle.sh` — proves a new migration can be generated,
  applied and rolled back on a clean database, and that the drift guard actually
  fires on an un-migrated schema change.

The DB-free unit test `tests/prisma-migrations.test.ts` (part of `npm test`)
additionally locks the **baseline** to `schema.prisma`: it fails while the repo
has no migration history, and fails if you edit the schema without regenerating
the baseline, so a missing migration is caught even without a database.

Run the database-backed checks locally against the compose Postgres:

```bash
docker compose up -d postgres
# create an empty shadow database alongside `lens`
DATABASE_URL=postgresql://lens:lens@localhost:5432/lens \
DIRECT_DATABASE_URL=postgresql://lens:lens@localhost:5432/lens \
SHADOW_DATABASE_URL=postgresql://lens:lens@localhost:5432/lens_shadow \
  npm run db:drift-check
```

## Rolling back a bad migration

Prisma does not generate down-migrations. In a **non-production** environment,
`npm run db:reset` drops the schema and re-applies every committed migration,
which is the clean, reproducible way to back out of a half-applied change. In
production, roll forward: commit a new migration that reverses the change and
`migrate deploy` it. Either way the history in `prisma/migrations/` is the
source of truth — the thing `db push` never gave us.

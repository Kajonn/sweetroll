# SQL migrations

Production migrations are immutable UTF-8 SQL files named `NNNN_snake_case.sql`.
The migrate process applies files in lexical order and records each SHA-256 checksum in `schema_migrations`.
Never modify an applied file; add a new migration to change the schema.
Each file runs in its own transaction while the process holds a PostgreSQL advisory lock.

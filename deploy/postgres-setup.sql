-- Run once as a Postgres superuser on the existing server, e.g.
--   sudo -u postgres psql -f postgres-setup.sql
-- or for Postgres in Docker:
--   docker exec -i <postgres container> psql -U postgres < postgres-setup.sql
-- Replace the password first. The app creates its own tables on start.

CREATE ROLE ai_homework LOGIN PASSWORD 'change-me';
CREATE DATABASE ai_homework OWNER ai_homework;
-- Keep it separate from the other systems' databases.
REVOKE ALL ON DATABASE ai_homework FROM PUBLIC;

-- Postgres on the host (not in Docker) must also accept connections from the Docker bridge:
--   postgresql.conf:  listen_addresses = 'localhost,172.17.0.1'
--   pg_hba.conf:      host  ai_homework  ai_homework  172.16.0.0/12  scram-sha-256
-- then reload Postgres.

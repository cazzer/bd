## Purpose

Packaging Breakdown as container images that run as two apps on a small shared host (the SkyOS Jetson: `breakdown-db` and `breakdown`), configured entirely from the environment and capped so they don't starve the host's other services.

## ADDED Requirements

### Requirement: One multi-arch app image serves web and MCP

The project SHALL build one container image for linux/arm64 and linux/amd64 whose single container runs migrations and then serves both the web server (including the built browser client) and the MCP HTTP server. The image SHALL run as a non-root user and SHALL contain no credential. If either server exits, the container SHALL exit non-zero so its supervisor restarts it, and a stop signal SHALL shut both down cleanly.

#### Scenario: Both platforms build

- **WHEN** the image is built for linux/arm64 and linux/amd64
- **THEN** both builds succeed from the same Dockerfile

#### Scenario: Board served without a dev server

- **WHEN** the app container is running and a browser on an allowed host opens its root path
- **THEN** the board loads from the container alone, with no Vite process

#### Scenario: One server dies

- **WHEN** the MCP server process inside the container exits unexpectedly
- **THEN** the container exits non-zero rather than serving the web alone

### Requirement: Container configuration comes from the environment

Everything a deployment varies SHALL be set by environment variables on the app container: the database connection string, bind address, web and MCP ports, allowed hosts, and the media directory, each with a documented default. The container's entrypoint SHALL translate them into the servers' command-line flags, so the servers themselves read no environment variable beyond those the project already allows. Media SHALL live under one directory, suitable for a single named volume.

#### Scenario: Configured by env alone

- **WHEN** the app container is started with only `DATABASE_URL` and an allowed host set
- **THEN** it migrates, serves web and MCP on their default ports bound to all container interfaces, and accepts that host

#### Scenario: Media on a volume

- **WHEN** the media directory is a named volume and a review image is stored and the container is replaced
- **THEN** the image is still served after the replacement

### Requirement: The database app is tuned for a small cap

The project SHALL supply Postgres settings for the `breakdown-db` app (the stock pgvector Postgres 16 image) that keep its memory within its cap, documented beside the cap. Together with the app container, the total memory limit SHALL be under 1 GB.

#### Scenario: Smoke test under the caps

- **WHEN** the smoke test starts both containers with their memory limits on a developer machine, creates a token, and exercises both servers through the published ports
- **THEN** health checks succeed with the token and get 401 without it, and neither container exceeds its limit or is killed

### Requirement: A local compose file runs the same two containers

A compose file SHALL run `breakdown-db` and `breakdown` locally with the same images, environment, caps, and named volumes as on the host, publishing on loopback by default, and without disturbing the development database.

#### Scenario: Local parity

- **WHEN** a developer runs the compose file
- **THEN** the two containers start with the same configuration the Jetson apps use, and the existing development database keeps running untouched

### Requirement: Host-only features degrade cleanly

A feature that depends on a binary absent from the image (`bd`, `herdr`) SHALL report itself unavailable when used, with a message naming the missing binary, and SHALL NOT crash the server or block startup.

#### Scenario: Review decision without bd

- **WHEN** a review decision that would run `bd` is submitted to the web server in the container
- **THEN** the caller gets an error naming `bd` as unavailable, and the server keeps serving

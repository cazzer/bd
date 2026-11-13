## Purpose

Packaging Breakdown as a container image and a resource-capped compose deployment, so it runs on a small shared host (the SkyOS Jetson) without starving the host's other services.

## ADDED Requirements

### Requirement: One multi-arch image runs either server

The project SHALL build one container image for linux/arm64 and linux/amd64 that can run the web server (which also serves the built browser client) or the MCP HTTP server, selected by the container's command. The image SHALL run as a non-root user and SHALL contain no credential.

#### Scenario: Both platforms build

- **WHEN** the image is built for linux/arm64 and linux/amd64
- **THEN** both builds succeed from the same Dockerfile

#### Scenario: Board served without a dev server

- **WHEN** the web container is running and a browser on an allowed host opens its root path
- **THEN** the board loads from the container alone, with no Vite process

### Requirement: The compose stack is capped

A compose project for the Jetson SHALL run Postgres, a one-shot migration step, the web server, and the MCP server, each with a memory limit, a swap limit equal to its memory limit, and a CPU limit. The sum of the memory limits SHALL be under 1 GB and SHALL be documented beside the per-service numbers. Postgres SHALL be configured for its limit, so that its working memory under normal load stays within it. Each long-running service SHALL restart on failure, and the servers SHALL start only after migrations succeed.

#### Scenario: Limits in force

- **WHEN** the stack is up
- **THEN** every service reports a memory limit, and the limits sum to under 1 GB

#### Scenario: Smoke test under the caps

- **WHEN** the smoke test brings the stack up on a developer machine, creates a token, and exercises both servers
- **THEN** health checks succeed with the token and get 401 without it from outside the containers, and no service exceeds its memory limit or is killed

### Requirement: Data paths are configurable

Where Postgres data and review media are stored SHALL be configurable per deployment, defaulting to named volumes, without adding an environment variable the application reads. Inside the compose network the servers SHALL reach Postgres by its service name.

#### Scenario: Data on an external disk

- **WHEN** the stack is started with the data path pointed at a directory on an attached disk
- **THEN** Postgres stores its data there and the stack behaves as with the default volume

### Requirement: Host-only features degrade cleanly

A feature that depends on a binary absent from the image (`bd`, `herdr`) SHALL report itself unavailable when used, with a message naming the missing binary, and SHALL NOT crash the server or block startup.

#### Scenario: Review decision without bd

- **WHEN** a review decision that would run `bd` is submitted to the web server in the container
- **THEN** the caller gets an error naming `bd` as unavailable, and the server keeps serving

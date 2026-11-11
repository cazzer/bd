# Spec Delta

## Purpose

Keep the person's inbox to items an agent has already digested. An item declares which artifacts its agent actually opened. An item that skipped its primary artifact is held for another agent pass and does not reach the person.

## ADDED Requirements

### Requirement: An inbox item declares what its agent read

An inbox item's metadata SHALL accept `read`: a list of at most 20 entries. Each entry has:
- a `ref`: a URL or a canonical key, at most 500 characters;
- a `depth`: `full` or `skimmed`.

Every writer of inbox items SHALL normalize it. An entry that breaks these rules SHALL be refused, naming the item and `read`.

#### Scenario: A reviewed pull request

- **WHEN** an agent writes an item for PR #971 with `url` set to the PR and `read` holding the PR's diff URL at depth `full`
- **THEN** the item is stored as pending with its `read` list as written

### Requirement: An item that skipped its primary artifact is held as undigested

An item SHALL be stored with status `undigested` instead of `pending` when both hold:
- the item has a primary `url`;
- no `read` entry's `ref` equals that `url` or starts with it.

Undigested items SHALL NOT appear in Needs me or in its count. They SHALL be listed in their own tab, which is visible to the person but not counted. An item without a `url` is not held.

#### Scenario: Diff not read

- **WHEN** an agent writes an item for PR #971 with `url` set to the PR and an empty `read`
- **THEN** the item is stored as undigested, Needs me does not list it, and the Undigested tab does

#### Scenario: Transcript fetched

- **WHEN** an agent writes a Fathom item whose `url` is the call, and `read` holds the call URL with depth `full`
- **THEN** the item is stored as pending

### Requirement: Re-writing a digested item releases it

When a writer re-writes an undigested item (same key) so that `read` now covers its `url`, the item SHALL move to `pending`. A re-write that still does not cover it SHALL leave it undigested. No other status SHALL move to `undigested` because of a re-write.

#### Scenario: Ingest pass digests a held item

- **WHEN** the ingest skill reads PR #971's diff and re-writes the held item with `read` covering its URL
- **THEN** the item moves to pending and appears in Needs me

### Requirement: The person can release or dismiss an undigested item

The person SHALL be able to dismiss an undigested item. The person SHALL also be able to move it to Needs me as it is; that move is recorded in the item's feedback as `release`.

#### Scenario: Releasing by hand

- **WHEN** the person releases an undigested email item whose attachment the agent could not open
- **THEN** it moves to pending, and its history shows it was released by hand

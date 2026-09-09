## ADDED Requirements

### Requirement: The timeline shows elapsed time, not just order

The timeline SHALL convey the passage of time between the items it lists, not only their order. Consecutive items separated by a long interval SHALL be visibly further apart, or separated by an explicit marker of the interval, than items that happened close together, so that bursts of activity and quiet stretches are apparent from the shape of the page without reading any row. The interval conveyed SHALL be bounded, so that one very old item cannot push the rest of the list off the page.

#### Scenario: A burst reads as a burst

- **WHEN** a timeline holds eight items within one hour followed by one item three weeks later
- **THEN** the eight are visibly grouped close together and the gap before the ninth is visibly larger, without the reader comparing timestamps

#### Scenario: A long gap does not consume the page

- **WHEN** two consecutive items are separated by an interval far larger than any other in the list
- **THEN** the gap is marked as an unusually long one rather than rendered to scale, and the remaining rows stay on the page

### Requirement: A date is stated once per group, not once per row

The timeline SHALL group the items it lists by the calendar period they fall in and SHALL name that period once for the group, rather than repeating it on every row. A row SHALL carry only the part of its time that its group does not already state. The current group's name SHALL remain visible while that group's rows are being read.

#### Scenario: The date is not repeated

- **WHEN** fifty items all fall on the same day
- **THEN** that day is named once, and no row repeats it

#### Scenario: The group stays identified while scrolling

- **WHEN** a person scrolls through a long group's rows
- **THEN** the period those rows belong to remains visible

#### Scenario: Crossing into a new period

- **WHEN** the list crosses from one calendar period into the next
- **THEN** the new period is named where the crossing occurs

### Requirement: A row's type is readable without reading it

A timeline row SHALL carry a visual indication of its node type, drawn from the same type-to-appearance assignment the graph uses, so that a person can tell a row's type without reading its text and so that a type looks the same in the timeline as it does in the graph. Text that is identical on every row of a page SHALL NOT occupy the row's primary content.

#### Scenario: Two types are distinguishable at a glance

- **WHEN** a timeline lists rows of two different node types
- **THEN** the two are visually distinct without the reader reading either row's type name

#### Scenario: A type looks the same across views

- **WHEN** a node type appears both in the graph and in a timeline row
- **THEN** it is given the same visual assignment in both

#### Scenario: Constant text is demoted

- **WHEN** every row on a page shares the same source system and the same relation to the anchor
- **THEN** that shared text does not occupy each row's primary content, and remains reachable for a row the person inspects

### Requirement: Type chips report what the loaded page holds

When the timeline offers type chips, each chip that is part of the current narrowing SHALL report how many of the loaded rows it accounts for, under a statement of that scope, so that a person can see a page's type composition and predict what deselecting a chip would do without deselecting it. A chip that accounts for none of the loaded rows SHALL be distinguishable from one that accounts for many. A chip OUTSIDE the current narrowing SHALL report no number at all.

That last clause is the honest limit, not an omission. A deselected chip's rows were never read, so any number shown for it would be invented — and "0" specifically would assert there are none, which is the one actively false reading available. Answering "what would this deselected chip show" needs a per-type read the timeline deliberately does not perform.

#### Scenario: Composition is visible from the chips

- **WHEN** a timeline's loaded rows are entirely of one type, and the other types its view names are also selected
- **THEN** the chips show that concentration, with the others reporting no items, under a caption naming the loaded rows as the scope of every count

#### Scenario: A chip predicts its own effect

- **WHEN** a person considers deselecting a chip that is currently selected
- **THEN** the chip states how many of the loaded rows it accounts for, so the effect of deselecting it is known in advance

#### Scenario: A deselected chip claims nothing

- **WHEN** a chip is not part of the current narrowing, so none of its rows have been read
- **THEN** it reports no count rather than reporting zero

#### Scenario: A newly selected chip does not claim zero while its rows load

- **WHEN** a person selects a chip and the page for the widened narrowing has not yet arrived, so the previous page's rows are still on screen
- **THEN** that chip reports no count until rows loaded under the new narrowing are shown, rather than reporting zero against rows that could not have contained it

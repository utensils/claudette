---
name: Technical Design Document (TDD)
about: Propose a technical design for a new feature or significant change
title: "TDD: "
labels: tdd
assignees: ""
---

# YYYYMMDD {Subject}

## Introduction

State the problem or idea driving the TDD in 2-3 sentences. If available, also provide a link to the product/design documents.

## Resources (optional)

Links to any further background or information should be included here.

## Glossary (optional)

| Term | Definition |
|------|-----------|
| **Term** | Definition |

## Current State (optional)

If this is an update to an existing process, give a quick overview of the current state of how this works today.

## Future State (optional)

If this is an update to an existing process, give an overview of the future state. This helps to highlight key differences from the current state, allowing the reader to better understand the scope of changes. For each significant paragraph, what additional context might the audience need to better understand why a particular design choice was made? What options were not taken and why? Are there any additional features, new information or changes to existing data, or other improvements that should be highlighted? At important points, ask yourself "Why?" to justify design decisions, refine the design, and reduce the number of feedback cycles.

## Not in Scope

This section should include some specific items that are NOT in scope of this TDD or project, or are planned for a future phase. It is best to call out any high-stakes items that may have been discussed or included in designs, but are not being considered as part of this particular TDD or project.

## Technical Design

This section has the most flexibility, but should at least include the following two sections. The main content of this document should be here to ensure one can understand the high-level proposed design, and any considerations.

### Summary

Provide a TLDR of the technical design in a few sentences. Provide context on the design change, including different approaches considered (if applicable), and ultimately which one was selected and why and what changes need to be made and where those changes need to be made. Also provide any other high-level notes about the design/change that are relevant.

### {Design Section}

Add as many subsections as needed to cover:
- Data model changes
- State machines / lifecycle flows
- New DAL modules, API endpoints, UI pages
- Integration points with existing systems
- Key algorithms or business logic

## ERD

Link or embed a diagram showing any proposed changes to database models here.

## Release Plan

Describe the plan for releasing this change. Consider and document:
- Any changes that need to be released in a specific order (including dependencies between services or components).
- Migration strategies (e.g., data backfills, schema changes, dual-writing).
- Feature flags or other mechanisms used to control rollout and rollback.
- Whether this release is expected to cause any downtime or other interruption to the business, and how that impact will be minimized.

## Monitoring/Telemetry

Provide a guide for how we will monitor and track this feature, as well as any new monitoring or dashboards that need to be added/updated (both mandatory, and nice-to-have).

### Mandatory

New monitors that are considered mandatory scope listed here.

### Nice to have

Nice-to-have monitors that are not required for this feature, but would be useful data.

## Testing

Provide insight into the base use cases that need to be considered, as well as any specific notes to help understand how this feature will be tested.

### Use Cases

| # | Use Case | Expected Outcome |
|---|----------|------------------|
| 1 | Description | Expected result |

### Testing Notes

Any testing considerations including any specific caveats, or just general areas of the application to be familiar with in order to test this thoroughly.

## Steps to Completion

This is a detailed breakdown of the work by area (if possible). This should function as a "first pass" of creating tickets from the epic. Ideally, the work listed here would be ordered as much as possible (and possibly even segmented by release according to the proposed Release Plan section above).

## Open Questions

List any questions that still need to be answered here. Ideally, tag the owner of the decision, and cross them out as we reach a final decision. Make sure that the final decision is incorporated back into the appropriate section(s) of the TDD.

1. ~~Example resolved question~~ **RESOLVED:** Answer here.
2. Open question that still needs an answer — @owner

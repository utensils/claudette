/** Data attribute stamped on a rendered `WorkflowCard` so the status pill
 *  can find and scroll to it.
 *
 *  A DOM lookup rather than a ref because the two components sit in
 *  unrelated subtrees — the card is somewhere inside the virtualized
 *  transcript (possibly inside a completed turn from several turns ago),
 *  the pill is pinned above the composer. Threading a ref between them
 *  would mean routing it through `MessagesWithTurns` and `TurnSummary`,
 *  both god files.
 *
 *  Shared constant so the producer and the querying consumer can't drift. */
export const WORKFLOW_CARD_ANCHOR_ATTR = "data-workflow-tool-use-id";

import { BoxRenderable, TextRenderable, TextAttributes, type CliRenderer } from "@opentui/core";
import { TextNodeRenderable } from "@opentui/core";
import type { GitHubPR } from "../types";
import { Theme } from "../theme";
import { getRelativeTime } from "./github";

export interface PRTileOptions {
  pr: GitHubPR;
  selected?: boolean;
  width?: number | `${number}%` | "auto";
}

// Nerd Font icons for PR states
const ICONS = {
  prOpen: "\uf407",        // nf-oct-git_pull_request
  prClosed: "\uf408",      // nf-oct-git_pull_request_closed
  prMerged: "\uf419",      // nf-oct-git_merge
  prDraft: "\uf49a",       // nf-oct-git_pull_request_draft
  approved: "\uf00c",      // nf-fa-check
  changesRequested: "\uf071", // nf-fa-exclamation_triangle
  reviewRequired: "\uf06a",   // nf-fa-exclamation_circle
  branch: "\ue725",        // nf-dev-git_branch
};

// Get PR state color
function getPRStateColor(pr: GitHubPR): string {
  if (pr.isDraft) return Theme.muted;
  if (pr.state === "merged") return Theme.secondary; // Purple-ish
  if (pr.state === "closed") return Theme.error;
  return Theme.success; // open
}

export function getPRSelectedBorderColor(pr: GitHubPR): string {
  // Draft PRs use Theme.muted for their state color, which is also the default
  // unselected border color. Use the accent border so selection remains visible.
  return pr.isDraft ? Theme.accent : getPRStateColor(pr);
}

// Get contrasting text color for a background
// For bright colors like green, we need dark text
function getContrastTextColor(bgColor: string): string {
  // For green/success colors, always use a dark color for readability
  if (bgColor === Theme.success) {
    return "#000000"; // Black text on green
  }
  // For other colors, use the standard approach
  return Theme.isLight ? Theme.background : "#000000";
}

// Get review status info
function getReviewInfo(pr: GitHubPR): { icon: string; color: string; text: string } | null {
  if (!pr.reviewDecision) return null;
  
  switch (pr.reviewDecision) {
    case "APPROVED":
      return { icon: ICONS.approved, color: Theme.success, text: "Approved" };
    case "CHANGES_REQUESTED":
      return { icon: ICONS.changesRequested, color: Theme.warning, text: "Changes" };
    case "REVIEW_REQUIRED":
      return { icon: ICONS.reviewRequired, color: Theme.muted, text: "Review" };
    default:
      return null;
  }
}

// Create a styled PR tile
export function createPRTile(
  renderer: CliRenderer,
  options: PRTileOptions
): BoxRenderable {
  const { pr, selected = false, width = "100%" } = options;

  const stateColor = getPRStateColor(pr);
  const borderColor = selected ? getPRSelectedBorderColor(pr) : Theme.muted;

  // Main PR container with border
  const tile = new BoxRenderable(renderer, {
    width,
    flexDirection: "column",
    border: true,
    borderColor,
    borderStyle: "rounded",
    backgroundColor: Theme.backgroundSubtle,
    marginBottom: 1,
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: 0,
    paddingBottom: 0,
  });

  // Row 1: PR badge + State | Review status | Time
  const row1 = new BoxRenderable(renderer, {
    width: "100%",
    flexDirection: "row",
    marginBottom: 0,
  });

  // PR icon based on state
  let prIcon = ICONS.prOpen;
  if (pr.isDraft) prIcon = ICONS.prDraft;
  else if (pr.state === "merged") prIcon = ICONS.prMerged;
  else if (pr.state === "closed") prIcon = ICONS.prClosed;

  // PR number badge with state color and contrasting text
  const badgeTextColor = getContrastTextColor(stateColor);
  const numberText = new TextRenderable(renderer, {
    content: ` ${prIcon} #${pr.number} `,
    fg: badgeTextColor,
    bg: stateColor,
    attributes: TextAttributes.BOLD,
  });
  row1.add(numberText);

  // Separator
  row1.add(new TextRenderable(renderer, { content: " " }));

  // State label
  let stateLabel = pr.state.toUpperCase();
  if (pr.isDraft) stateLabel = "DRAFT";
  row1.add(
    new TextRenderable(renderer, {
      content: stateLabel,
      fg: stateColor,
      attributes: TextAttributes.BOLD,
    })
  );

  // Review status
  const reviewInfo = getReviewInfo(pr);
  if (reviewInfo) {
    row1.add(new TextRenderable(renderer, { content: "  " }));
    row1.add(
      new TextRenderable(renderer, {
        content: `${reviewInfo.icon} ${reviewInfo.text}`,
        fg: reviewInfo.color,
      })
    );
  }

  // Spacer to push time to right
  const spacer1 = new BoxRenderable(renderer, {
    flexGrow: 1,
    backgroundColor: Theme.transparent,
  });
  row1.add(spacer1);

  // Time on the right
  const relativeTime = getRelativeTime(pr.updatedAt);
  row1.add(
    new TextRenderable(renderer, {
      content: relativeTime,
      fg: Theme.muted,
    })
  );

  tile.add(row1);

  // Row 2: Title (on its own line)
  const row2 = new BoxRenderable(renderer, {
    width: "100%",
    flexDirection: "row",
    marginTop: 0,
    marginBottom: 0,
  });

  const titleRenderable = new TextRenderable(renderer, {
    fg: Theme.text,
  });
  const titleNode = TextNodeRenderable.fromString(pr.title, {
    fg: Theme.text,
    attributes: TextAttributes.BOLD,
  });
  titleRenderable.add(titleNode);
  row2.add(titleRenderable);

  tile.add(row2);

  // Row 3: Author
  const row3 = new BoxRenderable(renderer, {
    width: "100%",
    flexDirection: "row",
    marginBottom: 0,
  });

  row3.add(
    new TextRenderable(renderer, {
      content: `@${pr.author}`,
      fg: Theme.muted,
    })
  );

  tile.add(row3);

  // Row 4: Branch
  const row4 = new BoxRenderable(renderer, {
    width: "100%",
    flexDirection: "row",
    marginBottom: 0,
  });

  row4.add(
    new TextRenderable(renderer, {
      content: `${ICONS.branch} ${pr.headRef}`,
      fg: Theme.muted,
    })
  );

  tile.add(row4);

  // Row 5: Stats + Labels (on its own line)
  const row5 = new BoxRenderable(renderer, {
    width: "100%",
    flexDirection: "row",
    justifyContent: "space-between",
  });

  // Left side: +/- stats
  const statsBox = new BoxRenderable(renderer, {
    flexDirection: "row",
    backgroundColor: Theme.transparent,
  });

  if (pr.additions !== undefined && pr.deletions !== undefined) {
    statsBox.add(
      new TextRenderable(renderer, {
        content: `+${pr.additions}`,
        fg: Theme.success,
      })
    );
    statsBox.add(new TextRenderable(renderer, { content: " " }));
    statsBox.add(
      new TextRenderable(renderer, {
        content: `-${pr.deletions}`,
        fg: Theme.error,
      })
    );
  }

  row5.add(statsBox);

  // Right side: Labels
  const labelsBox = new BoxRenderable(renderer, {
    flexDirection: "row",
    backgroundColor: Theme.transparent,
  });

  if (pr.labels && pr.labels.length > 0) {
    const labelsToShow = pr.labels.slice(0, 2);
    labelsBox.add(
      new TextRenderable(renderer, {
        content: labelsToShow.join(", "),
        fg: Theme.muted,
      })
    );
  }

  row5.add(labelsBox);

  tile.add(row5);

  return tile;
}

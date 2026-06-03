import { describe, expect, test } from "bun:test";
import { parseProtocolUrl } from "../src/helpers/cli";

describe("parseProtocolUrl", () => {
  test("parses card URLs with launch-ai", () => {
    expect(parseProtocolUrl("hatchet://card/123?path=/tmp/repo&launch-ai=true&with-context=true")).toEqual({
      card: 123,
      path: "/tmp/repo",
      launchAi: true,
      launchOpencode: true,
      withContext: true,
    });
  });

  test("parses legacy launch-opencode URLs", () => {
    expect(parseProtocolUrl("hatchet://pr/456?repo=herald&launch-opencode=true")).toEqual({
      pr: 456,
      repo: "herald",
      launchAi: true,
      launchOpencode: true,
    });
  });

  test("parses review PR URLs", () => {
    expect(parseProtocolUrl("hatchet://review-pr/789?path=/tmp/repo")).toEqual({
      reviewPr: 789,
      path: "/tmp/repo",
    });
  });
});

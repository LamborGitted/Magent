import { describe, expect, it, vi } from "vitest";
import { SkillsShRegistry } from "../src/core/skills-registry.js";

describe("SkillsShRegistry", () => {
  it("searches skills.sh and returns installable package identifiers", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      skills: [{
        id: "vercel-labs/agent-skills/vercel-react-best-practices",
        name: "vercel-react-best-practices",
        installs: 123,
        source: "vercel-labs/agent-skills",
      }],
    }), { status: 200 }));
    const registry = new SkillsShRegistry("https://skills.example", fetcher as typeof fetch);

    await expect(registry.search("react", "vercel-labs")).resolves.toEqual([{
      name: "vercel-react-best-practices",
      package: "vercel-labs/agent-skills@vercel-react-best-practices",
      slug: "vercel-labs/agent-skills/vercel-react-best-practices",
      installs: 123,
      url: "https://skills.example/vercel-labs/agent-skills/vercel-react-best-practices",
    }]);
    expect(fetcher).toHaveBeenCalledWith(
      "https://skills.example/api/search?q=react&limit=20&owner=vercel-labs",
    );
  });

  it("reports registry HTTP failures", async () => {
    const fetcher = vi.fn(async () => new Response("unavailable", { status: 503 }));
    const registry = new SkillsShRegistry("https://skills.example", fetcher as typeof fetch);
    await expect(registry.search("react")).rejects.toThrow("HTTP 503");
  });
});

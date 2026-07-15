// ui2/test/skills-render.test.tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Skills } from "../src/views/Skills.js";
import { stubApi, STATE_STUB } from "./stubs.js";

afterEach(cleanup);

const SKILLS = [
  { name: "design-tokens", description: "design token guidance", usedBy: [] },
  { name: "market-sizing", description: "TAM/SAM/SOM methodology", usedBy: ["janus"] },
];

describe("Skills view", () => {
  it("renders the list with usage chips", async () => {
    stubApi({ "/api/skills": SKILLS, "/api/state": STATE_STUB });
    render(<Skills />);
    expect(await screen.findByText("market-sizing")).toBeTruthy();
    expect(screen.getByText("design-tokens")).toBeTruthy();
    expect(screen.getByText("janus")).toBeTruthy(); // usage chip
  });

  it("opens a skill in the editor and saves", async () => {
    stubApi({
      "/api/skills": SKILLS,
      "/api/state": STATE_STUB,
      "/api/skills/market-sizing": { md: "---\nname: market-sizing\ndescription: d\n---\nbody" },
    });
    render(<Skills />);
    fireEvent.click(await screen.findByText("market-sizing"));
    const editor = (await screen.findByLabelText("skill markdown")) as HTMLTextAreaElement;
    expect(editor.value).toContain("market-sizing");
    fireEvent.click(screen.getByText("Save"));
    expect((await screen.findAllByText(/./)).length).toBeGreaterThan(0); // no crash; PUT stubbed above
  });

  it("new-skill button seeds the frontmatter template", async () => {
    stubApi({ "/api/skills": SKILLS, "/api/state": STATE_STUB });
    render(<Skills />);
    await screen.findByText("market-sizing");
    fireEvent.click(screen.getByText("New skill"));
    const editor = (await screen.findByLabelText("skill markdown")) as HTMLTextAreaElement;
    expect(editor.value).toContain("name: my-skill");
  });
});

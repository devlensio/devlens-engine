import fs from "fs";
import path from "path";
import os from "os";
import { parseRepo } from "./index.js";
import type { RenderSite } from "../../types.js";

function repo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devlens-render-test-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
}

function componentNode(dir: string, name: string) {
  return parseRepo(dir).nodes.find((n) => n.type === "COMPONENT" && n.name === name);
}

describe("render sites", () => {
  it("orders calls and JSX children on one axis", () => {
    const dir = repo({
      "src/Child.tsx": `
        export function Child() { return <span /> }
        export function Other() { return <span /> }
      `,
      "src/Parent.tsx": `
        import { Child, Other } from "./Child";
        export function Parent({ ok }: { ok: boolean }) {
          const data = useQuery(key);
          console.log("debug");
          return (
            <section>
              <Child value={data} />
              {ok && <Other />}
            </section>
          );
        }
      `,
    });

    const parent = componentNode(dir, "Parent");
    const sites = parent?.metadata.renderSites as RenderSite[] | undefined;

    expect(sites).toBeDefined();
    expect(sites!.map((s) => s.name)).toEqual(["Child", "Other"]);
    // console.log is a builtin: it consumes no ordinal, so the children land on 2 and 3.
    expect(sites!.map((s) => s.order)).toEqual([2, 3]);
    expect(sites![0].depth).toBe(1);
    expect(sites![0].conditional).toBeUndefined();
    expect(sites![1].conditional).toBe(true);

    const callSites = parent?.metadata.callSites as { name: string; order?: number }[];
    expect(callSites.map((c) => [c.name, c.order])).toEqual([["useQuery", 1]]);
  });

  it("flags children rendered inside a map", () => {
    const dir = repo({
      "src/Card.tsx": `export function Card({ id }: { id: number }) { return <div>{id}</div> }`,
      "src/List.tsx": `
        import { Card } from "./Card";
        export function List({ ids }: { ids: number[] }) {
          return <ul>{ids.map((id) => <Card id={id} key={id} />)}</ul>;
        }
      `,
    });

    const sites = componentNode(dir, "List")?.metadata.renderSites as RenderSite[];
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ name: "Card", repeat: true });
  });

  it("ignores html elements, fragments, context providers and nested helpers", () => {
    const dir = repo({
      "src/Widget.tsx": `
        export function Widget() {
          const paint = () => <Thing />;
          return (
            <div>
              <>
                <span />
                <Ctx.Provider value={1}>x</Ctx.Provider>
              </>
            </div>
          );
        }
      `,
    });

    const sites = componentNode(dir, "Widget")?.metadata.renderSites as RenderSite[] | undefined;
    expect(sites ?? []).toHaveLength(0);
  });
});
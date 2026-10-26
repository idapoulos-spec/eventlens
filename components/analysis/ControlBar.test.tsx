import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ControlBar } from "./ControlBar";

describe("ControlBar", () => {
  it("puts the text first, then every control's buttons in one group, then their messages, the notes, and open forms", () => {
    const html = renderToStaticMarkup(
      <ControlBar
        lead={<span>Windows end now.</span>}
        controls={[
          { buttons: <button>A</button>, panel: <form>A form</form> },
          { buttons: <button>B</button>, status: <span>B done</span> },
          { buttons: <button>C</button>, status: null, panel: false },
        ]}
        notes={<p>A note</p>}
      />,
    );
    // One row: the text, then one group holding all three buttons, in order.
    expect(html).toMatch(/<div class="flex flex-wrap items-center gap-x-3 gap-y-2"><span>Windows end now\.<\/span><div class="flex flex-wrap items-center gap-2"><button>A<\/button><button>B<\/button><button>C<\/button><\/div><\/div>/);
    // Below it, in this order: the messages, the notes, and the forms.
    const at = (text: string) => html.indexOf(text);
    expect(at("B done")).toBeGreaterThan(at("<button>C</button>"));
    expect(at("A note")).toBeGreaterThan(at("B done"));
    expect(at("A form")).toBeGreaterThan(at("A note"));
  });

  it("leaves out the messages line when no control has one", () => {
    const html = renderToStaticMarkup(<ControlBar controls={[{ buttons: <button>A</button> }]} />);
    expect(html).not.toContain("gap-y-1");
  });
});

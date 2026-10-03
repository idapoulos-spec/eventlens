import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LoginForm } from "./LoginForm";

// The form imports the sign-in action, whose server-only marker throws outside React's server environment.
vi.mock("server-only", () => ({}));

describe("LoginForm", () => {
  it("renders a labeled password field and passes the page to return to", () => {
    const html = renderToStaticMarkup(<LoginForm next={"/?stock=NVDA&kalshi=KXFED"} />);
    expect(html).toContain('<label for="password"');
    const input = html.match(/<input id="password"[^>]*>/)?.[0] ?? "";
    for (const attribute of ['type="password"', 'name="password"', 'required=""', '="current-password"']) {
      expect(input).toContain(attribute);
    }
    expect(html).toContain('<input type="hidden" name="next" value="/?stock=NVDA&amp;kalshi=KXFED"/>');
    expect(html).toContain(">Sign in</button>");
  });
});

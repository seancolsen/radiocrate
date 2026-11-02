import { httpError } from "api-client";
import { describe, expect, it } from "vitest";

describe("httpError", () => {
  it("keeps the API's plain-text reason", async () => {
    const res = new Response("database is locked", { status: 500 });
    expect((await httpError(res)).message).toBe("500 database is locked");
  });

  it("boils a proxy's HTML page down to its title", async () => {
    const page = `<!doctype html>
<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->
<head>
<title>Cloudflare Tunnel error |
  music.example &amp; co | Cloudflare</title>
<script>(function(){ /* … */ })();</script>
</head>
<body>${"<p>filler</p>".repeat(500)}</body>`;
    const res = new Response(page, { status: 530 });
    expect((await httpError(res)).message).toBe(
      "530 Cloudflare Tunnel error | music.example & co | Cloudflare",
    );
  });

  it("says only the status when there's no reason to give", async () => {
    expect((await httpError(new Response("", { status: 502 }))).message).toBe(
      "502",
    );
    const untitled = new Response("<html><body>Bad gateway</body></html>", {
      status: 502,
    });
    expect((await httpError(untitled)).message).toBe("502");
  });
});

/**
 * MwBot — lightweight MediaWiki Action API client.
 * No dependencies beyond fetch (Node 18+ / browser / Bun / Deno).
 */

export interface MwPage {
  title: string;
  content: string;
  lastRevId?: number;
  touched?: string;
}

export interface MwBotOptions {
  /** e.g. "http://localhost:8082" */
  baseUrl: string;
  username: string;
  password: string;
}

export class MwBot {
  private readonly api: string;
  private cookies: Record<string, string> = {};
  private csrfToken = "+\\";

  constructor(private readonly opts: MwBotOptions) {
    this.api = `${opts.baseUrl.replace(/\/$/, "")}/api.php`;
  }

  // ── Auth ────────────────────────────────────────────────────────────────────

  async login(): Promise<void> {
    // Step 1: get login token
    const { query } = await this.get({ meta: "tokens", type: "login" });
    const loginToken = query.tokens.logintoken;

    // Step 2: login
    const result = await this.post({
      action: "login",
      lgname: this.opts.username,
      lgpassword: this.opts.password,
      lgtoken: loginToken,
    });
    if (result.login?.result !== "Success") {
      throw new Error(`MwBot login failed: ${result.login?.reason ?? JSON.stringify(result)}`);
    }

    // Step 3: get CSRF token for edits
    const { query: q2 } = await this.get({ meta: "tokens" });
    this.csrfToken = q2.tokens.csrftoken;
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  async getPage(title: string): Promise<MwPage | null> {
    const data = await this.get({
      prop: "revisions",
      titles: title,
      rvprop: "content|ids",
      rvslots: "main",
    });
    const pages = Object.values(data.query.pages) as any[];
    const p = pages[0];
    if (p.missing !== undefined) return null;
    const slot = p.revisions?.[0]?.slots?.main;
    return {
      title: p.title,
      content: slot?.["*"] ?? slot?.content ?? "",
      lastRevId: p.revisions?.[0]?.revid,
      touched: p.touched,
    };
  }

  async getAllPages(opts: { namespace?: number; limit?: number } = {}): Promise<string[]> {
    const titles: string[] = [];
    let apcontinue: string | undefined;
    const limit = opts.limit ?? 500;

    do {
      const data = await this.get({
        list: "allpages",
        apnamespace: String(opts.namespace ?? 0),
        aplimit: String(Math.min(limit - titles.length, 500)),
        ...(apcontinue ? { apcontinue } : {}),
      });
      for (const p of data.query.allpages) titles.push(p.title);
      apcontinue = data.continue?.apcontinue;
    } while (apcontinue && titles.length < limit);

    return titles;
  }

  async search(query: string, limit = 20): Promise<string[]> {
    const data = await this.get({
      list: "search",
      srsearch: query,
      srlimit: String(limit),
      srnamespace: "0",
    });
    return data.query.search.map((r: any) => r.title);
  }

  /** Get titles of pages in a category (e.g. "OpenFS Synthesized") */
  async getCategoryMembers(category: string, limit = 500): Promise<string[]> {
    try {
      const data = await this.get({
        list: "categorymembers",
        cmtitle: `Category:${category}`,
        cmlimit: String(limit),
        cmnamespace: "0",
      });
      return (data.query?.categorymembers ?? []).map((m: any) => m.title);
    } catch {
      return [];
    }
  }

  async getRecentChanges(limit = 10, opts: { hideBots?: boolean } = {}): Promise<Array<{ title: string; timestamp: string; user: string; comment: string; revid: number }>> {
    const params: any = {
      list: "recentchanges",
      rclimit: String(limit),
      rcprop: "title|timestamp|user|comment|ids",
      rcnamespace: "0",
      rctype: "edit|new",
    };
    if (opts.hideBots) params.rcshow = "!bot";
    const data = await this.get(params);
    return data.query.recentchanges;
  }

  // ── Write ───────────────────────────────────────────────────────────────────

  async editPage(title: string, content: string, summary = "OpenFS agent edit"): Promise<void> {
    const result = await this.post({
      action: "edit",
      title,
      text: content,
      summary,
      token: this.csrfToken,
      bot: "1",
    });
    if (result.edit?.result !== "Success") {
      throw new Error(`MwBot edit failed: ${JSON.stringify(result)}`);
    }
  }

  async appendToPage(title: string, content: string, summary = "OpenFS agent append"): Promise<void> {
    const result = await this.post({
      action: "edit",
      title,
      appendtext: "\n" + content,
      summary,
      token: this.csrfToken,
      bot: "1",
    });
    if (result.edit?.result !== "Success") {
      throw new Error(`MwBot append failed: ${JSON.stringify(result)}`);
    }
  }

  async deletePage(title: string, reason = "OpenFS agent delete"): Promise<void> {
    await this.post({ action: "delete", title, reason, token: this.csrfToken });
  }

  // ── HTTP helpers ────────────────────────────────────────────────────────────

  private cookieHeader(): string {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private saveCookies(res: Response): void {
    for (const [, v] of res.headers.entries()) {
      if (v.startsWith("Set-Cookie:") || res.headers.get("set-cookie")) {
        // parse simple key=value from set-cookie
      }
    }
    // fetch doesn't expose set-cookie in browser, but in Node/Bun it does
    const raw = (res as any).headers?.getSetCookie?.() ?? [];
    for (const c of raw) {
      const [kv] = c.split(";");
      const [k, val] = kv.split("=");
      if (k && val !== undefined) this.cookies[k.trim()] = val.trim();
    }
  }

  private async get(params: Record<string, string>): Promise<any> {
    const url = new URL(this.api);
    url.searchParams.set("action", params.action ?? "query");
    url.searchParams.set("format", "json");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const res = await fetch(url.toString(), {
      headers: { Cookie: this.cookieHeader(), Connection: "close" },
    });
    this.saveCookies(res);
    return res.json();
  }

  private async post(params: Record<string, string>): Promise<any> {
    const body = new URLSearchParams();
    body.set("format", "json");
    for (const [k, v] of Object.entries(params)) body.set(k, v);

    const res = await fetch(this.api, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: this.cookieHeader(),
        Connection: "close",
      },
      body: body.toString(),
    });
    this.saveCookies(res);
    return res.json();
  }
}

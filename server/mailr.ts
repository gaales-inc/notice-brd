/**
 * Client for mailr, the suite's internal mail service.
 *
 * mailr's `POST /send` is reachable only on the compose network
 * (`http://mailr:8025`), so this server is a legitimate caller and a browser never
 * is. Content is described as blocks; mailr renders the HTML and derives the
 * plain-text part from the same blocks.
 */

const MAILR_URL = (process.env.MAILR_URL || "http://mailr:8025").replace(/\/+$/, "");
const MAILR_API_KEY = process.env.MAILR_API_KEY || "";

export type MailBlock =
  | { type: "heading"; text: string }
  | { type: "text"; text: string }
  | { type: "note"; text: string }
  | { type: "button"; label: string; url: string }
  | { type: "link"; url: string }
  | { type: "code"; text: string }
  | { type: "facts"; items: [string, string][] }
  | { type: "divider" };

export interface Mail {
  to: string;
  subject: string;
  /** A brand mailr knows; anything unrecognised falls back to `gaales`. */
  brand?: string;
  preheader?: string;
  footer_note?: string;
  blocks: MailBlock[];
}

export type Mailer = (mail: Mail) => Promise<void>;

export const sendMail: Mailer = async (mail) => {
  if (!MAILR_API_KEY) {
    // Logging instead of sending is opt-in and never inferred: a missing key in
    // production has to fail loudly, not quietly eat someone's sign-in code.
    if (process.env.MAILR_DEV_CONSOLE === "1") {
      console.info("[mailr] no API key — message not sent:", JSON.stringify(mail));
      return;
    }
    throw new Error("MAILR_API_KEY is not set");
  }

  const res = await fetch(`${MAILR_URL}/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MAILR_API_KEY}`,
    },
    body: JSON.stringify(mail),
    signal: AbortSignal.timeout(45_000),
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`mailr ${res.status}: ${detail}`);
  }
};

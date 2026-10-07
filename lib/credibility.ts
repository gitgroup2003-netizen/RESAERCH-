import { Source } from "./types";

/** Hosts we treat as high-trust institutional or primary-literature sources. */
const GOV_SUFFIXES = [".gov", ".gov.uk", ".gov.au", ".gc.ca", ".europa.eu", ".go.ug", ".go.ke", ".gov.za", ".gov.in"];
const INTL_ORGS = [
  "who.int",
  "un.org",
  "worldbank.org",
  "imf.org",
  "oecd.org",
  "unicef.org",
  "fao.org",
  "ilo.org",
  "wto.org",
  "unesco.org",
  "ourworldindata.org",
  "cdc.gov",
  "nih.gov",
  "nature.com",
  "science.org",
  "thelancet.com",
  "nejm.org",
  "bmj.com",
  "cell.com",
  "pnas.org",
  "arxiv.org",
  "reuters.com",
  "apnews.com",
  "bbc.co.uk",
];
const LOW_TRUST = [
  "reddit.com",
  "quora.com",
  "medium.com",
  "blogspot.",
  "wordpress.com",
  "pinterest.",
  "facebook.com",
  "tiktok.com",
  "x.com",
  "twitter.com",
  "answers.com",
  "yahoo.com/answers",
];

export const GOV_DOMAINS_FOR_SEARCH = [
  "gov",
  "edu",
  "who.int",
  "un.org",
  "worldbank.org",
  "imf.org",
  "oecd.org",
  "europa.eu",
  "unicef.org",
  "fao.org",
  "nih.gov",
  "cdc.gov",
  "ourworldindata.org",
];

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function isGovernmentOrInstitutional(url: string): boolean {
  const h = hostOf(url);
  if (!h) return false;
  return (
    GOV_SUFFIXES.some((s) => h.endsWith(s)) ||
    h.endsWith(".edu") ||
    h.includes(".ac.") ||
    INTL_ORGS.some((d) => h === d || h.endsWith("." + d))
  );
}

/**
 * Transparent, rule-based credibility score. Every point added/removed is
 * recorded in `credibilityNotes` so users can see WHY a source ranks where it does.
 */
export function scoreSource(s: Omit<Source, "credibility" | "credibilityNotes" | "id">): {
  credibility: number;
  credibilityNotes: string[];
} {
  const notes: string[] = [];
  let score = 40;
  const host = hostOf(s.url);

  if (s.kind === "document") {
    return { credibility: 70, credibilityNotes: ["Supplied by you — treated as provided evidence"] };
  }

  if (s.kind === "academic") {
    score += 25;
    notes.push("Indexed scholarly record (+25)");
    if (s.doi) {
      score += 8;
      notes.push("Has a DOI (+8)");
    }
    if (s.venue && !/arxiv|preprint|ssrn|research square|biorxiv|medrxiv/i.test(s.venue)) {
      score += 7;
      notes.push("Published in a named venue (+7)");
    } else if (s.venue) {
      notes.push("Preprint — not yet peer reviewed (0)");
    }
    if (typeof s.citations === "number") {
      const bonus = s.citations >= 500 ? 10 : s.citations >= 100 ? 8 : s.citations >= 20 ? 5 : s.citations >= 5 ? 2 : 0;
      if (bonus) {
        score += bonus;
        notes.push(`${s.citations} citations (+${bonus})`);
      }
    }
  }

  if (isGovernmentOrInstitutional(s.url)) {
    score += 25;
    notes.push(`Institutional / government domain ${host} (+25)`);
  }
  if (LOW_TRUST.some((d) => host.includes(d))) {
    score -= 25;
    notes.push(`User-generated or low-trust domain ${host} (−25)`);
  }
  if (s.url.startsWith("https://")) {
    score += 3;
  } else if (s.url) {
    score -= 5;
    notes.push("Not served over HTTPS (−5)");
  }
  if (s.year) {
    const age = new Date().getFullYear() - s.year;
    if (age <= 3) {
      score += 4;
      notes.push("Recent (+4)");
    } else if (age > 15) {
      score -= 4;
      notes.push("Older than 15 years (−4)");
    }
  }
  if (s.authors && s.authors.length) {
    score += 3;
    notes.push("Named authors (+3)");
  }

  return { credibility: Math.max(0, Math.min(100, score)), credibilityNotes: notes };
}

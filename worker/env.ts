/**
 * Site Check's bindings.
 *
 * Declared as an exported type rather than by augmenting the global `Env`,
 * because Deep Screen already owns that global and the two Workers do not have
 * the same bindings. Two products in one repository stay legible only if
 * neither can quietly reach the other's storage — and a type collision here
 * would be the first step towards exactly that.
 */
export interface Env {
  /** Site Check's own database. Not Deep Screen's. */
  readonly DB: D1Database;

  /** Site Check's own bucket, holding site photos and the documents read against them. */
  readonly PHOTOS: R2Bucket;

  /**
   * Reviews run here, not in the request. Work started from a request is cut
   * off after about thirty seconds, and a review reads a dozen photographs
   * against the whole knowledge base.
   */
  readonly REVIEWS: Queue<{ reviewId: string }>;

  /**
   * Whether a new submission reviews itself. Off by default: a review costs
   * real money, and switching it on should be a decision someone made rather
   * than a side effect of deploying.
   */
  readonly AUTO_REVIEW: string;

  /** The model the review runs on. */
  readonly REVIEW_MODEL: string;

  readonly ANTHROPIC_API_KEY?: string;

  /** monday.com. Reads the submission, posts the review back as an update. */
  readonly MONDAY_API_TOKEN?: string;

  /**
   * The call-up board, and the only two columns this Worker may write.
   *
   * An allow-list in configuration rather than a lookup against the board. A
   * column being physically present is not the same as it being ours to write
   * — Deep Screen found a column its registry had retired still sitting live
   * on the board, which a liveness check would have sailed straight past.
   */
  readonly MONDAY_BOARD_ID: string;
  readonly VERDICT_COLUMN: string;
  readonly WHY_COLUMN: string;

  /** Shared secret the monday webhook presents when an item is created. */
  readonly WEBHOOK_TOKEN?: string;

  /**
   * Shared secret the SharePoint index flow presents when pushing folder names.
   * Absent means the push endpoint refuses everything, which is the safe
   * default: an unauthenticated index can be poisoned, and a poisoned index
   * aims a review at the wrong job's documents.
   */
  readonly PUSH_TOKEN?: string;

  /** The document fetch flow's HTTP trigger URL. The URL is itself a credential. */
  readonly FLOW_FETCH_URL?: string;

  /**
   * The folder listing flow's HTTP trigger URL. A separate flow rather than a
   * mode switch inside one: Power Automate compares an expression's result
   * against the literal text in the other box, so a comparison that looks
   * right can silently never match. Two flows with one job each have no
   * comparison to get wrong.
   */
  readonly FLOW_LIST_URL?: string;

  /** Shared secret the Worker presents to the document fetch flow. */
  readonly FLOW_FETCH_TOKEN?: string;
}
